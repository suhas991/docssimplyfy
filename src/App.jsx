import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import './App.css'

const Joyride = lazy(() => import('react-joyride').then((module) => ({ default: module.Joyride })))

let pdfJsPromise = null

async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
      ([pdfJsModule, workerModule]) => {
        pdfJsModule.GlobalWorkerOptions.workerSrc = workerModule.default
        return pdfJsModule
      },
    )
  }

  return pdfJsPromise
}

const STORAGE_KEY = 'docs-site.library.v1'
const GH_PROVIDER_TOKEN_STORAGE_KEY = 'docs-site.github-provider-token.v1'
const VIEW_STORAGE_KEY = 'docs-site.active-view.v1'
const POST_AUTH_VIEW_KEY = 'docs-site.post-auth-view.v1'
const SYNC_META_STORAGE_KEY = 'docs-site.sync-meta.v1'
const READ_DOC_SOURCES_STORAGE_KEY = 'docs-site.read-doc-sources.v1'
const TOUR_DONE_KEY = 'docs-site.tour-done.v1'
const TOUR_AUTO_SHOWN_KEY = 'docs-site.tour-auto-shown.v1'
const DESKTOP_TOUR_DONE_KEY = 'docs-site.tour-desktop-done.v1'
const MOBILE_TOUR_DONE_KEY = 'docs-site.tour-mobile-done.v1'
const BACKUP_REPO_NAME = 'docs-hub-backup'
const BACKUP_REPO_FILE = 'docs-library-backup.json'
const LIBRARY_DB_NAME = 'docs-site-db'
const LIBRARY_DB_VERSION = 3
const LIBRARY_STORE_NAME = 'app-state'
const LIBRARY_STORE_KEY = 'library'
const RAG_CHUNKS_STORE_NAME = 'rag_chunks'
const RAG_EMBEDDINGS_STORE_NAME = 'rag_embeddings'
const RAG_META_STORE_NAME = 'rag_meta'
const RAG_META_KEY = 'index-meta'
const RAG_EMBED_META_KEY = 'embedding-meta'
const GEMINI_EMBEDDING_MODEL = import.meta.env.VITE_GEMINI_EMBED_MODEL || 'gemini-embedding-001'
const GEMINI_EMBEDDING_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || ''
const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY || ''
const GROQ_CHAT_MODEL = import.meta.env.VITE_GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile'
const LOCAL_EMBEDDING_MODEL = 'all-MiniLM-L6-v2'
const LOCAL_EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const GEMINI_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000
const EMBEDDING_FLUSH_BATCH_SIZE = 20
const SUPPORTED_LOCAL_DOC_PATTERN = /\.(md|mdx|pdf)$/i
const SUPPORTED_TEXT_DOC_PATTERN = /\.(md|mdx)$/i
const PDF_DOC_PATTERN = /\.pdf$/i

let miniLmEmbedderPromise = null
let geminiRateLimitedUntilMs = 0

function createClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function openLibraryDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }

    const request = indexedDB.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(LIBRARY_STORE_NAME)) {
        db.createObjectStore(LIBRARY_STORE_NAME, { keyPath: 'key' })
      }

      if (!db.objectStoreNames.contains(RAG_CHUNKS_STORE_NAME)) {
        const chunkStore = db.createObjectStore(RAG_CHUNKS_STORE_NAME, { keyPath: 'chunkId' })
        chunkStore.createIndex('docId', 'docId', { unique: false })
        chunkStore.createIndex('hash', 'hash', { unique: false })
      }

      if (!db.objectStoreNames.contains(RAG_EMBEDDINGS_STORE_NAME)) {
        const embeddingStore = db.createObjectStore(RAG_EMBEDDINGS_STORE_NAME, { keyPath: 'chunkId' })
        embeddingStore.createIndex('hash', 'hash', { unique: false })
        embeddingStore.createIndex('model', 'model', { unique: false })
        embeddingStore.createIndex('modelHash', 'modelHash', { unique: false })
      }

      if (!db.objectStoreNames.contains(RAG_META_STORE_NAME)) {
        db.createObjectStore(RAG_META_STORE_NAME, { keyPath: 'key' })
      }
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onerror = () => {
      reject(request.error || new Error('Failed to open IndexedDB'))
    }
  })
}

async function readLibraryFromIndexedDb() {
  const db = await openLibraryDb()
  if (!db) {
    return null
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LIBRARY_STORE_NAME, 'readonly')
    const store = transaction.objectStore(LIBRARY_STORE_NAME)
    const request = store.get(LIBRARY_STORE_KEY)

    request.onsuccess = () => {
      const record = request.result
      resolve(Array.isArray(record?.value) ? record.value : null)
    }

    request.onerror = () => {
      reject(request.error || new Error('Failed to read library from IndexedDB'))
    }

    transaction.oncomplete = () => {
      db.close()
    }
  })
}

async function writeLibraryToIndexedDb(library) {
  const db = await openLibraryDb()
  if (!db) {
    return
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LIBRARY_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(LIBRARY_STORE_NAME)
    store.put({ key: LIBRARY_STORE_KEY, value: library, updatedAt: new Date().toISOString() })

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }

    transaction.onerror = () => {
      db.close()
      reject(transaction.error || new Error('Failed to save library to IndexedDB'))
    }
  })
}

async function deleteLibraryFromIndexedDb() {
  const db = await openLibraryDb()
  if (!db) {
    return
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(LIBRARY_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(LIBRARY_STORE_NAME)
    store.delete(LIBRARY_STORE_KEY)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }

    transaction.onerror = () => {
      db.close()
      reject(transaction.error || new Error('Failed to clear library from IndexedDB'))
    }
  })
}

async function writeRagChunksToIndexedDb(chunks, meta = {}) {
  const db = await openLibraryDb()
  if (!db) {
    return
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([RAG_CHUNKS_STORE_NAME, RAG_META_STORE_NAME], 'readwrite')
    const chunkStore = transaction.objectStore(RAG_CHUNKS_STORE_NAME)
    const metaStore = transaction.objectStore(RAG_META_STORE_NAME)

    chunkStore.clear()
    for (const chunk of chunks) {
      chunkStore.put(chunk)
    }

    metaStore.put({
      key: RAG_META_KEY,
      chunkCount: chunks.length,
      indexedAt: new Date().toISOString(),
      ...meta,
    })

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }

    transaction.onerror = () => {
      db.close()
      reject(transaction.error || new Error('Failed to write RAG chunks to IndexedDB'))
    }
  })
}

async function readAllRagChunksFromIndexedDb() {
  const db = await openLibraryDb()
  if (!db) {
    return []
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RAG_CHUNKS_STORE_NAME, 'readonly')
    const store = transaction.objectStore(RAG_CHUNKS_STORE_NAME)
    const request = store.getAll()

    request.onsuccess = () => {
      resolve(Array.isArray(request.result) ? request.result : [])
    }

    request.onerror = () => {
      reject(request.error || new Error('Failed to read RAG chunks from IndexedDB'))
    }

    transaction.oncomplete = () => {
      db.close()
    }
  })
}

async function readAllRagEmbeddingsFromIndexedDb() {
  const db = await openLibraryDb()
  if (!db) {
    return []
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RAG_EMBEDDINGS_STORE_NAME, 'readonly')
    const store = transaction.objectStore(RAG_EMBEDDINGS_STORE_NAME)
    const request = store.getAll()

    request.onsuccess = () => {
      resolve(Array.isArray(request.result) ? request.result : [])
    }

    request.onerror = () => {
      reject(request.error || new Error('Failed to read RAG embeddings from IndexedDB'))
    }

    transaction.oncomplete = () => {
      db.close()
    }
  })
}

async function writeRagEmbeddingsToIndexedDb(embeddings, meta = {}) {
  const db = await openLibraryDb()
  if (!db) {
    return
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([RAG_EMBEDDINGS_STORE_NAME, RAG_META_STORE_NAME], 'readwrite')
    const embeddingStore = transaction.objectStore(RAG_EMBEDDINGS_STORE_NAME)
    const metaStore = transaction.objectStore(RAG_META_STORE_NAME)

    for (const record of embeddings) {
      embeddingStore.put(record)
    }

    metaStore.put({
      key: RAG_EMBED_META_KEY,
      updatedAt: new Date().toISOString(),
      ...meta,
    })

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }

    transaction.onerror = () => {
      db.close()
      reject(transaction.error || new Error('Failed to write RAG embeddings to IndexedDB'))
    }
  })
}

function getEmbeddingModelName() {
  if (GEMINI_EMBEDDING_API_KEY && Date.now() >= geminiRateLimitedUntilMs) {
    return GEMINI_EMBEDDING_MODEL
  }

  return LOCAL_EMBEDDING_MODEL
}

function getRagStatusTone(status) {
  const value = String(status || '').toLowerCase()
  if (value.includes('failed') || value.includes('error')) {
    return 'bad'
  }

  if (value.includes('ready') || value.includes('answered')) {
    return 'good'
  }

  return 'warn'
}

function getGeminiRateLimitCooldownMs(response) {
  const retryAfter = response.headers.get('retry-after')
  const parsedRetryAfter = Number(retryAfter)
  if (Number.isFinite(parsedRetryAfter) && parsedRetryAfter > 0) {
    return parsedRetryAfter * 1000
  }

  return GEMINI_RATE_LIMIT_COOLDOWN_MS
}

function normalizeVector(values) {
  let sumSquares = 0
  for (const value of values) {
    const number = Number(value || 0)
    sumSquares += number * number
  }

  const magnitude = Math.sqrt(sumSquares) || 1
  return values.map((value) => Number((Number(value || 0) / magnitude).toFixed(8)))
}

async function getMiniLmEmbedder() {
  if (!miniLmEmbedderPromise) {
    miniLmEmbedderPromise = import('@huggingface/transformers').then(async ({ env, pipeline }) => {
      env.allowLocalModels = false
      env.allowRemoteModels = true
      env.useBrowserCache = true

      return pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL_ID, { quantized: true })
    })
  }

  return miniLmEmbedderPromise
}

async function embedTextWithLocalMiniLm(text) {
  const embedder = await getMiniLmEmbedder()
  const output = await embedder(String(text || ''), {
    pooling: 'mean',
    normalize: true,
  })

  if (output?.data && output.data.length) {
    return Array.from(output.data, (value) => Number(value))
  }

  if (typeof output?.tolist === 'function') {
    const list = output.tolist()
    if (Array.isArray(list) && list.length) {
      const first = Array.isArray(list[0]) ? list[0] : list
      if (Array.isArray(first) && first.length) {
        return normalizeVector(first)
      }
    }
  }

  throw new Error('Local MiniLM embedding output was empty')
}

async function embedTextWithGemini(text) {
  if (!GEMINI_EMBEDDING_API_KEY) {
    return null
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_EMBEDDING_MODEL)}:embedContent?key=${encodeURIComponent(GEMINI_EMBEDDING_API_KEY)}`

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: {
        parts: [{ text: String(text || '') }],
      },
      taskType: 'RETRIEVAL_DOCUMENT',
    }),
  })

  if (response.status === 429) {
    const cooldownMs = getGeminiRateLimitCooldownMs(response)
    geminiRateLimitedUntilMs = Date.now() + cooldownMs
    throw new Error(`Gemini rate limited for ${Math.ceil(cooldownMs / 1000)} seconds`) 
  }

  if (!response.ok) {
    throw new Error(`Gemini embedding request failed: ${response.status}`)
  }

  const payload = await response.json()
  const values = payload?.embedding?.values

  if (!Array.isArray(values) || !values.length) {
    throw new Error('Gemini embedding response was empty')
  }

  return values.map((value) => Number(value))
}

async function createEmbeddingVector(text) {
  const canUseGemini = GEMINI_EMBEDDING_API_KEY && Date.now() >= geminiRateLimitedUntilMs
  if (canUseGemini) {
    try {
      const geminiEmbedding = await embedTextWithGemini(text)
      if (geminiEmbedding && geminiEmbedding.length) {
        return geminiEmbedding
      }
    } catch {
      // Fall back to local MiniLM embedding if Gemini fails or is rate-limited.
    }
  }

  return embedTextWithLocalMiniLm(text)
}

async function syncRagEmbeddingsFromChunks(chunks, onProgress) {
  const model = getEmbeddingModelName()
  const allExisting = await readAllRagEmbeddingsFromIndexedDb()

  const existingByModelHash = new Map()
  for (const record of allExisting) {
    if (record?.model === model && record?.modelHash) {
      existingByModelHash.set(record.modelHash, record)
    }
  }

  const missing = []
  for (const chunk of chunks) {
    const modelHash = `${model}:${chunk.hash}`
    if (!existingByModelHash.has(modelHash)) {
      missing.push(chunk)
    }
  }

  if (!missing.length) {
    await writeRagEmbeddingsToIndexedDb([], {
      model,
      embeddedChunkCount: chunks.length,
      pendingChunkCount: 0,
    })

    if (onProgress) {
      onProgress({ processed: chunks.length, total: chunks.length, created: 0, reused: chunks.length, model })
    }

    return {
      created: 0,
      reused: chunks.length,
      total: chunks.length,
      model,
    }
  }

  const recordsToFlush = []
  let created = 0
  const reused = chunks.length - missing.length

  for (let index = 0; index < missing.length; index += 1) {
    const chunk = missing[index]
    const embedding = await createEmbeddingVector(chunk.content)
    const modelHash = `${model}:${chunk.hash}`

    recordsToFlush.push({
      chunkId: chunk.chunkId,
      docId: chunk.docId,
      hash: chunk.hash,
      model,
      modelHash,
      embedding,
      dimensions: embedding.length,
      updatedAt: new Date().toISOString(),
    })
    created += 1

    if (recordsToFlush.length >= EMBEDDING_FLUSH_BATCH_SIZE) {
      const batch = recordsToFlush.splice(0, recordsToFlush.length)
      await writeRagEmbeddingsToIndexedDb(batch, {
        model,
        embeddedChunkCount: reused + created,
        pendingChunkCount: missing.length - (index + 1),
      })
    }

    if (onProgress) {
      onProgress({
        processed: reused + created,
        total: chunks.length,
        created,
        reused,
        model,
      })
    }
  }

  if (recordsToFlush.length) {
    await writeRagEmbeddingsToIndexedDb(recordsToFlush, {
      model,
      embeddedChunkCount: chunks.length,
      pendingChunkCount: 0,
    })
  }

  return {
    created,
    reused,
    total: chunks.length,
    model,
  }
}

function cosineSimilarity(vectorA, vectorB) {
  if (!Array.isArray(vectorA) || !Array.isArray(vectorB) || !vectorA.length || vectorA.length !== vectorB.length) {
    return -1
  }

  let dot = 0
  let normA = 0
  let normB = 0

  for (let index = 0; index < vectorA.length; index += 1) {
    const a = Number(vectorA[index] || 0)
    const b = Number(vectorB[index] || 0)
    dot += a * b
    normA += a * a
    normB += b * b
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (!denominator) {
    return -1
  }

  return dot / denominator
}

async function retrieveRagTopChunks({ query, topK = 5, scopeSection = '', minScore = 0.08 }) {
  const trimmedQuery = String(query || '').trim()
  if (!trimmedQuery) {
    return { model: getEmbeddingModelName(), totalCandidates: 0, results: [] }
  }

  const model = getEmbeddingModelName()
  const [chunks, embeddings] = await Promise.all([readAllRagChunksFromIndexedDb(), readAllRagEmbeddingsFromIndexedDb()])
  if (!chunks.length || !embeddings.length) {
    return { model, totalCandidates: 0, results: [] }
  }

  const queryEmbedding = await createEmbeddingVector(trimmedQuery)
  const requiredDimensions = queryEmbedding.length

  const chunkById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]))
  const normalizedScopeSection = String(scopeSection || '').trim().toLowerCase()

  const scored = []
  for (const embedding of embeddings) {
    if (embedding?.model !== model) {
      continue
    }

    if (!Array.isArray(embedding?.embedding) || embedding.embedding.length !== requiredDimensions) {
      continue
    }

    const chunk = chunkById.get(embedding.chunkId)
    if (!chunk) {
      continue
    }

    if (normalizedScopeSection && String(chunk.section || '').toLowerCase() !== normalizedScopeSection) {
      continue
    }

    const score = cosineSimilarity(queryEmbedding, embedding.embedding)
    if (!Number.isFinite(score) || score < minScore) {
      continue
    }

    scored.push({
      chunkId: chunk.chunkId,
      docId: chunk.docId,
      title: chunk.title,
      section: chunk.section,
      source: chunk.source,
      sourceRepo: chunk.sourceRepo,
      content: chunk.content,
      score,
    })
  }

  scored.sort((a, b) => b.score - a.score)

  return {
    model,
    totalCandidates: scored.length,
    results: scored.slice(0, Math.max(1, topK)),
  }
}

function buildContextFromChunks(chunks, maxChunks = 6) {
  return chunks.slice(0, maxChunks).map((chunk, index) => {
    return [
      `[Chunk ${index + 1}]`,
      `Title: ${chunk.title}`,
      `Section: ${chunk.section}`,
      `Source: ${chunk.sourceRepo}`,
      `Content: ${chunk.content}`,
    ].join('\n')
  }).join('\n\n')
}

function buildLocalGroundedFallbackAnswer(question, chunks) {
  const top = chunks.slice(0, 3)
  const bullets = top.map((chunk) => `- ${chunk.title} (${chunk.section}): ${chunk.content.slice(0, 220)}${chunk.content.length > 220 ? '...' : ''}`)

  return [
    `I could not call Groq right now, so this is a grounded local summary for: "${question}".`,
    '',
    'Relevant excerpts:',
    ...bullets,
    '',
    'Tip: set VITE_GROQ_API_KEY to enable full AI answers.',
  ].join('\n')
}

async function askGroqWithContext({ question, chunks }) {
  if (!GROQ_API_KEY) {
    return buildLocalGroundedFallbackAnswer(question, chunks)
  }

  const context = buildContextFromChunks(chunks, 6)
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_CHAT_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You are a documentation assistant. Answer only using the provided context. If context is insufficient, say so clearly. Keep answers concise and include actionable points.',
        },
        {
          role: 'user',
          content: `Context:\n${context}\n\nQuestion:\n${question}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Groq request failed: ${response.status} ${text}`)
  }

  const data = await response.json()
  return String(data?.choices?.[0]?.message?.content || '').trim()
}

async function clearRagChunksFromIndexedDb() {
  const db = await openLibraryDb()
  if (!db) {
    return
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([RAG_CHUNKS_STORE_NAME, RAG_META_STORE_NAME], 'readwrite')
    const chunkStore = transaction.objectStore(RAG_CHUNKS_STORE_NAME)
    const metaStore = transaction.objectStore(RAG_META_STORE_NAME)

    chunkStore.clear()
    metaStore.delete(RAG_META_KEY)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }

    transaction.onerror = () => {
      db.close()
      reject(transaction.error || new Error('Failed to clear RAG chunks from IndexedDB'))
    }
  })
}

async function clearRagEmbeddingsFromIndexedDb() {
  const db = await openLibraryDb()
  if (!db) {
    return
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([RAG_EMBEDDINGS_STORE_NAME, RAG_META_STORE_NAME], 'readwrite')
    const embeddingStore = transaction.objectStore(RAG_EMBEDDINGS_STORE_NAME)
    const metaStore = transaction.objectStore(RAG_META_STORE_NAME)

    embeddingStore.clear()
    metaStore.delete(RAG_EMBED_META_KEY)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }

    transaction.onerror = () => {
      db.close()
      reject(transaction.error || new Error('Failed to clear RAG embeddings from IndexedDB'))
    }
  })
}

function formatDateTime(value) {
  if (!value) {
    return 'Never'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Never'
  }

  return date.toLocaleString()
}

function getWordCount(value) {
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*_~\-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) {
    return 0
  }

  return text.split(' ').length
}

function formatReadTimeFromWords(wordCount) {
  if (!wordCount) {
    return 'Less than 1 min read'
  }

  const wordsPerMinute = 220
  const minutes = Math.max(1, Math.ceil(wordCount / wordsPerMinute))
  return `${minutes} min read`
}

function normalizeView(value) {
  if (value === 'sync') {
    return 'git'
  }

  if (value === 'dashboard' || value === 'git' || value === 'chat' || value === 'settings' || value === 'profile') {
    return value
  }

  return 'dashboard'
}

function toSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function getFolderName(value) {
  return value || 'General'
}

function getFileNameWithoutExtension(value) {
  return value.replace(/\.(md|mdx|pdf)$/i, '')
}

function parseOrderPrefix(value) {
  const match = value.match(/^(\d+)/)
  return match ? Number(match[1]) : null
}

function compareBySourceName(a, b) {
  const aPrefix = parseOrderPrefix(a)
  const bPrefix = parseOrderPrefix(b)

  if (aPrefix !== null && bPrefix !== null && aPrefix !== bPrefix) {
    return aPrefix - bPrefix
  }

  if (aPrefix !== null && bPrefix === null) {
    return -1
  }

  if (aPrefix === null && bPrefix !== null) {
    return 1
  }

  return a.localeCompare(b)
}

function normalizeDocPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim()
}

function parseDocLocation(doc) {
  if (!doc) {
    return { repoKey: 'local:Local Uploads', path: '' }
  }

  const githubMatch = String(doc.source || '').match(/^github:([^/]+\/[^/]+)\/(.+)$/)
  if (githubMatch) {
    return {
      repoKey: `github:${githubMatch[1]}`,
      path: normalizeDocPath(githubMatch[2]),
    }
  }

  return {
    repoKey: `local:${doc.sourceRepo || 'Local Uploads'}`,
    path: normalizeDocPath(doc.source || ''),
  }
}

function isPdfDoc(doc) {
  if (!doc) {
    return false
  }

  if (String(doc.format || '').toLowerCase() === 'pdf') {
    return true
  }

  const sourcePath = String(doc.source || '')
  return PDF_DOC_PATTERN.test(sourcePath)
}

function isMarkdownLikeDoc(doc) {
  if (!doc) {
    return false
  }

  const format = String(doc.format || '').toLowerCase()
  if (format === 'pdf') {
    return false
  }

  if (format === 'markdown') {
    return true
  }

  if (!String(doc.content || '').trim()) {
    return false
  }

  return !PDF_DOC_PATTERN.test(String(doc.source || ''))
}

function getPathVariants(path) {
  const normalized = normalizeDocPath(path)
  if (!normalized) {
    return []
  }

  const basename = normalized.split('/').pop() || normalized
  const withoutExt = normalized.replace(/\.(md|mdx|pdf)$/i, '')
  const basenameWithoutExt = basename.replace(/\.(md|mdx|pdf)$/i, '')

  return Array.from(new Set([normalized, withoutExt, basename, basenameWithoutExt]))
}

function splitHref(rawHref) {
  const href = String(rawHref || '')
  const hashIndex = href.indexOf('#')
  const queryIndex = href.indexOf('?')

  const pathEnd =
    hashIndex >= 0 && queryIndex >= 0
      ? Math.min(hashIndex, queryIndex)
      : hashIndex >= 0
        ? hashIndex
        : queryIndex >= 0
          ? queryIndex
          : href.length

  const path = href.slice(0, pathEnd)
  const hash = hashIndex >= 0 ? href.slice(hashIndex + 1) : ''

  return { path, hash }
}

function resolveRelativePath(basePath, hrefPath) {
  const sourcePath = normalizeDocPath(basePath)
  const targetPath = normalizeDocPath(hrefPath)

  const baseDir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) : ''
  const merged = `${baseDir}${targetPath}`

  const resolvedParts = []
  for (const part of merged.split('/')) {
    if (!part || part === '.') {
      continue
    }

    if (part === '..') {
      resolvedParts.pop()
      continue
    }

    resolvedParts.push(part)
  }

  return resolvedParts.join('/')
}

function getSectionFromFile(file) {
  const relativePath = file.webkitRelativePath || ''

  if (relativePath.includes('/')) {
    const [firstFolder] = relativePath.split('/')
    return getFolderName(firstFolder)
  }

  const fileNameWithoutExt = getFileNameWithoutExtension(file.name)
  if (fileNameWithoutExt.includes('__')) {
    const [prefix] = fileNameWithoutExt.split('__')
    return getFolderName(prefix)
  }

  return 'General'
}

function getTitleFromFile(file) {
  return getFileNameWithoutExtension(file.name)
}

function getSectionFromPath(path) {
  if (!path.includes('/')) {
    return 'General'
  }

  const [firstFolder] = path.split('/')
  return getFolderName(firstFolder)
}

function getTitleFromPath(path) {
  const name = path.split('/').pop() || path
  return getFileNameWithoutExtension(name)
}

function getRepoFromSource(source) {
  if (!source || typeof source !== 'string') {
    return 'Local Uploads'
  }

  if (source.startsWith('github:')) {
    const withoutPrefix = source.replace('github:', '')
    const [owner, repo] = withoutPrefix.split('/')
    if (owner && repo) {
      return `${owner}/${repo}`
    }
  }

  return 'Local Uploads'
}

function parseGitHubRepo(input) {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  const withoutCommand = trimmed.replace(/^git\s+clone\s+/i, '')
  const normalized = withoutCommand
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^git:\/\/github\.com\//i, 'https://github.com/')
    .replace(/^www\.github\.com\//i, 'https://github.com/')
    .replace(/^github\.com\//i, 'https://github.com/')
  let url

  try {
    if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
      url = new URL(normalized)
    } else {
      url = new URL(`https://github.com/${normalized.replace(/^\/+/, '')}`)
    }
  } catch {
    return null
  }

  if (url.hostname !== 'github.com') {
    return null
  }

  const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
  if (parts.length < 2) {
    return null
  }

  return {
    owner: parts[0],
    repo: parts[1],
  }
}

function getGitHubLoginFromSupabaseUser(user) {
  if (!user) {
    return ''
  }

  const fromMetadata =
    user.user_metadata?.user_name ||
    user.user_metadata?.preferred_username ||
    user.user_metadata?.username ||
    ''

  if (fromMetadata) {
    return String(fromMetadata)
  }

  const githubIdentity = (user.identities || []).find((identity) => identity.provider === 'github')
  const fromIdentity =
    githubIdentity?.identity_data?.user_name ||
    githubIdentity?.identity_data?.preferred_username ||
    githubIdentity?.identity_data?.login ||
    ''

  return String(fromIdentity)
}

function mergeDocsIntoLibrary(previous, docs) {
  const existingDocs = previous.flatMap((section) => section.docs)
  const existingBySource = new Map(
    existingDocs.map((doc) => [doc.source, { ...doc, sourceRepo: doc.sourceRepo || getRepoFromSource(doc.source) }]),
  )

  for (const doc of docs) {
    existingBySource.set(doc.source, {
      ...doc,
      sourceRepo: doc.sourceRepo || getRepoFromSource(doc.source),
    })
  }

  const docsBySection = new Map()
  for (const doc of existingBySource.values()) {
    const repo = doc.sourceRepo || 'Local Uploads'
    const section = doc.section || 'General'
    const key = `${repo}:::${section}`

    if (!docsBySection.has(key)) {
      docsBySection.set(key, {
        sourceRepo: repo,
        section,
        docs: [],
      })
    }

    docsBySection.get(key).docs.push(doc)
  }

  return Array.from(docsBySection.values())
    .map((group) => ({
      id: toSlug(`${group.sourceRepo}-${group.section}`),
      title: group.section,
      sourceRepo: group.sourceRepo,
      docs: group.docs.sort(docSort),
    }))
    .sort(sectionSort)
}

function toGitHubApiPath(path, useProxy = true) {
  if (import.meta.env.DEV && useProxy) {
    return `/github-api${path}`
  }

  return `https://api.github.com${path}`
}

function encodeRepoPath(path) {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function decodeGitHubContent(base64Content) {
  const sanitized = base64Content.replace(/\n/g, '')
  const bytes = Uint8Array.from(atob(sanitized), (char) => char.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

function decodeGitHubContentToBytes(base64Content) {
  const sanitized = base64Content.replace(/\n/g, '')
  return Uint8Array.from(atob(sanitized), (char) => char.charCodeAt(0))
}

function encodeBytesToBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

function decodeBase64ToBytes(base64Content) {
  return Uint8Array.from(atob(String(base64Content || '')), (char) => char.charCodeAt(0))
}

async function renderPdfPagesToDataUrls(pdfBytes, targetWidth) {
  const pdfJs = await loadPdfJs()
  const loadingTask = pdfJs.getDocument({ data: pdfBytes })
  const pdf = await loadingTask.promise
  const pages = []
  const outputScale = Math.min(2.2, Math.max(1, window.devicePixelRatio || 1))

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const baseViewport = page.getViewport({ scale: 1 })
    const fitScale = Math.max(1, targetWidth / Math.max(1, baseViewport.width))
    const viewport = page.getViewport({ scale: fitScale })

    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) {
      throw new Error('Could not create canvas context for PDF page rendering.')
    }

    canvas.width = Math.ceil(viewport.width * outputScale)
    canvas.height = Math.ceil(viewport.height * outputScale)
    canvas.style.width = `${Math.ceil(viewport.width)}px`
    canvas.style.height = `${Math.ceil(viewport.height)}px`
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'

    await page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    }).promise
    pages.push(canvas.toDataURL('image/png'))
  }

  return pages
}

async function fetchGitHubBinaryFromDownloadUrl(downloadUrl, token) {
  if (!downloadUrl) {
    return null
  }

  const response = await fetch(downloadUrl, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })

  if (!response.ok) {
    return null
  }

  return new Uint8Array(await response.arrayBuffer())
}

async function getFileContent(file) {
  if (PDF_DOC_PATTERN.test(file.name)) {
    return ''
  }

  return file.text()
}

async function getLocalPdfBase64(file) {
  const pdfBytes = new Uint8Array(await file.arrayBuffer())
  return encodeBytesToBase64(pdfBytes)
}

function encodeGitHubContent(content) {
  const encoded = new TextEncoder().encode(content)
  let binary = ''
  for (const byte of encoded) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

async function githubRequest(path, token, options = {}) {
  let lastError = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const useProxy = attempt === 0
    const url = toGitHubApiPath(path, useProxy)

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.headers || {}),
        },
      })

      if (!response.ok) {
        const errorText = await response.text()
        const apiError = `GitHub API error on ${path}: ${response.status} ${response.statusText}. ${errorText}`
        if (attempt === 1 || !import.meta.env.DEV) {
          throw new Error(apiError)
        }
        lastError = apiError
        continue
      }

      if (response.status === 204) {
        return null
      }

      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        return response.json()
      }

      return response.text()
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (attempt === 1 || !import.meta.env.DEV) {
        throw new Error(`${useProxy ? '[Proxy]' : '[Direct]'} ${lastError}`)
      }
    }
  }

  throw new Error(lastError || 'GitHub API request failed')
}

function explainGitHubError(error, fallbackMessage) {
  if (!(error instanceof Error)) {
    return fallbackMessage
  }

  const msg = error.message
  const lowerMessage = msg.toLowerCase()
  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false

  console.error('[GitHub Error]', msg)

  if (isOffline) {
    return 'Network is offline on this device. Reconnect internet and retry.'
  }

  if (lowerMessage.includes('internet_disconnected') || lowerMessage.includes('failed to fetch')) {
    return `Network issue: ${msg}. Check if you have internet and GitHub is reachable.`
  }

  if (lowerMessage.includes('networkerror')) {
    return 'Network connection failed. Check WiFi/mobile data and try again.'
  }

  if (msg.includes('Bad credentials')) {
    return 'GitHub token is invalid. Create a new token and try again.'
  }

  if (msg.includes('rate limit')) {
    return 'GitHub rate limit reached. Try again in an hour or use a token with higher limits.'
  }

  const isBackupRepoMissing =
    lowerMessage.includes(BACKUP_REPO_NAME.toLowerCase()) &&
    (lowerMessage.includes('404') || lowerMessage.includes('not found'))
  if (isBackupRepoMissing) {
    return 'No cloud backup found yet in your backup repository.'
  }

  if (
    lowerMessage.includes('403') ||
    lowerMessage.includes('resource not accessible') ||
    lowerMessage.includes('requires authentication') ||
    lowerMessage.includes('insufficient')
  ) {
    return 'GitHub permission issue. Disconnect and login again to refresh scopes.'
  }

  if (lowerMessage.includes('401') || lowerMessage.includes('bad credentials')) {
    return 'GitHub session expired. Disconnect and login again.'
  }

  if (msg.includes('Not Found')) {
    return 'Repository not found or you do not have access to it.'
  }

  if (msg.includes('[Proxy]') && msg.includes('[Direct]')) {
    return `Could not reach GitHub. Error: ${msg}. Ensure GitHub API is accessible.`
  }

  return fallbackMessage
}

async function fetchMarkdownDocsFromRepo({ owner, repo, token }) {
  const repoData = await githubRequest(`/repos/${owner}/${repo}`, token)
  const defaultBranch = repoData.default_branch

  const treeData = await githubRequest(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    token,
  )

  const supportedEntries = (treeData.tree || [])
    .filter((item) => item.type === 'blob')
    .filter((item) => /\.(md|mdx|pdf)$/i.test(item.path))

  if (!supportedEntries.length) {
    throw new Error('No supported files found in this repository (.md, .mdx, .pdf).')
  }

  const maxFiles = 120
  const limitedEntries = supportedEntries.slice(0, maxFiles)

  const docs = await Promise.all(
    limitedEntries.map(async (entry) => {
      const encodedPath = encodeRepoPath(entry.path)
      const fileData = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(defaultBranch)}`,
        token,
      )

      let content = ''

      if (PDF_DOC_PATTERN.test(entry.path)) {
        let pdfBytes = null

        if (fileData?.content) {
          pdfBytes = decodeGitHubContentToBytes(fileData.content)
        }

        if (!pdfBytes && entry.sha) {
          const blobData = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`, token)
          if (blobData?.content) {
            pdfBytes = decodeGitHubContentToBytes(blobData.content)
          }
        }

        if (!pdfBytes && fileData?.download_url) {
          pdfBytes = await fetchGitHubBinaryFromDownloadUrl(fileData.download_url, token)
        }

        if (!pdfBytes) {
          throw new Error(`Failed to download ${entry.path}`)
        }

        content = ''
        const pdfBase64 = encodeBytesToBase64(pdfBytes)

        return {
          id: `${toSlug(entry.path)}-${createClientId()}`,
          title: getTitleFromPath(entry.path),
          section: getSectionFromPath(entry.path),
          sourceRepo: `${owner}/${repo}`,
          source: `github:${owner}/${repo}/${entry.path}`,
          format: 'pdf',
          mimeType: 'application/pdf',
          pdfBase64,
          content,
          updatedAt: new Date().toISOString(),
        }
      } else {
        if (!fileData?.content) {
          throw new Error(`Failed to download ${entry.path}`)
        }

        content = decodeGitHubContent(fileData.content)
      }

      return {
        id: `${toSlug(entry.path)}-${createClientId()}`,
        title: getTitleFromPath(entry.path),
        section: getSectionFromPath(entry.path),
        sourceRepo: `${owner}/${repo}`,
        source: `github:${owner}/${repo}/${entry.path}`,
        format: 'markdown',
        content,
        updatedAt: new Date().toISOString(),
      }
    }),
  )

  return {
    docs,
    markdownCount: supportedEntries.length,
    importedCount: limitedEntries.length,
  }
}

async function fetchUserRepos(token) {
  const repos = []
  let page = 1

  while (true) {
    const pageData = await githubRequest(`/user/repos?type=owner&sort=updated&per_page=100&page=${page}`, token)
    repos.push(...pageData)

    if (!Array.isArray(pageData) || pageData.length < 100) {
      break
    }

    page += 1
  }

  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: Boolean(repo.private),
    description: repo.description || '',
    updatedAt: repo.updated_at,
  }))
}

async function waitForForkAvailability({ owner, repo, token, maxAttempts = 10 }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await githubRequest(`/repos/${owner}/${repo}`, token)
      return
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 1200)
      })
    }
  }

  throw new Error('Fork was created but is not available yet. Try sync again in a few seconds.')
}

function sectionSort(a, b) {
  const byRepo = (a.sourceRepo || 'Local Uploads').localeCompare(b.sourceRepo || 'Local Uploads')
  if (byRepo !== 0) {
    return byRepo
  }

  return compareBySourceName(a.section || a.title || '', b.section || b.title || '')
}

function docSort(a, b) {
  return compareBySourceName(a.title || '', b.title || '')
}

function getDesktopTourSteps() {
  return [
    {
      target: '.sidebar-nav-list .nav-link:nth-child(1)',
      content: 'Dashboard: read documents, track progress, and continue your current reading flow.',
      disableBeacon: true,
      placement: 'right',
    },
    {
      target: '.sidebar-nav-list .nav-link:nth-child(2)',
      content: 'Git: connect GitHub and sync markdown docs from repositories.',
      placement: 'right',
    },
    {
      target: '.sidebar-nav-list .nav-link:nth-child(3)',
      content: 'Local: upload files/folders, import/export library, and manage local storage.',
      placement: 'right',
    },
    {
      target: '.sidebar-nav-list .nav-link:nth-child(4)',
      content: 'AI Assistant: ask questions and retrieve grounded context from your docs.',
      placement: 'right',
    },
    {
      target: '.topbar-profile-button',
      content: 'Profile: use this top-right avatar to open account, cloud backup, restore, and replay tour controls.',
      placement: 'bottom',
    },
    {
      target: '.sidebar-search-input',
      content: 'Search docs instantly by title, section, source, and content.',
      placement: 'right',
    },
    {
      target: '.main-topbar',
      content: 'Your reading progress and top-level context are shown here while reading.',
      placement: 'bottom',
    },
    {
      target: '.document-panel',
      content: 'Read your markdown content here with responsive tables, links, and progress tracking.',
      placement: 'center',
    },
  ]
}

function getMobileTourSteps() {
  return [
    {
      target: '.mobile-bottom-nav .mobile-bottom-link:nth-child(1)',
      content: 'Dashboard: open and read your docs.',
      disableBeacon: true,
      placement: 'top',
    },
    {
      target: '.mobile-bottom-nav .mobile-bottom-link:nth-child(2)',
      content: 'Git: sync from GitHub repositories.',
      placement: 'top',
    },
    {
      target: '.mobile-bottom-nav .mobile-bottom-link:nth-child(3)',
      content: 'Local: upload, import/export, and manage local docs.',
      placement: 'top',
    },
    {
      target: '.mobile-bottom-nav .mobile-bottom-link:nth-child(4)',
      content: 'AI Assistant: ask questions grounded in your synced and local docs.',
      placement: 'top',
    },
    {
      target: '.topbar-profile-button',
      content: 'Profile: tap this top-right avatar for account, cloud backup, and restore controls.',
      placement: 'left',
    },
    {
      target: '.mobile-menu-button',
      content: 'Tap this menu button to open sections and pick documents.',
      placement: 'bottom',
    },
    {
      target: '.document-panel',
      content: 'This is your reading area. Scroll to track progress and mark docs as read.',
      placement: 'center',
    },
  ]
}

function App() {
  const [activeView, setActiveView] = useState(() => {
    return normalizeView(localStorage.getItem(VIEW_STORAGE_KEY))
  })
  const [library, setLibrary] = useState([])
  const [expandedSectionIds, setExpandedSectionIds] = useState(() => new Set())
  const [selectedDocId, setSelectedDocId] = useState('')
  const [dashboardSearchQuery, setDashboardSearchQuery] = useState('')
  const [deferredDashboardSearchQuery, setDeferredDashboardSearchQuery] = useState('')
  const [isSectionsPanelOpen, setIsSectionsPanelOpen] = useState(false)
  const [hasHydratedLibrary, setHasHydratedLibrary] = useState(false)
  const [error, setError] = useState('')
  const [storageWarning, setStorageWarning] = useState('')
  const [repoInput, setRepoInput] = useState('')
  const [isPullingRepo, setIsPullingRepo] = useState(false)
  const [repoStatus, setRepoStatus] = useState('')
  const [cloudBackupStatus, setCloudBackupStatus] = useState('')
  const [isBackingUpCloud, setIsBackingUpCloud] = useState(false)
  const [isRestoringCloud, setIsRestoringCloud] = useState(false)
  const [isDeletingCloudBackup, setIsDeletingCloudBackup] = useState(false)
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(true)
  const [lastAutoBackupAt, setLastAutoBackupAt] = useState('')
  const [syncMeta, setSyncMeta] = useState(() => {
    try {
      const cached = localStorage.getItem(SYNC_META_STORAGE_KEY)
      if (!cached) {
        return { summary: '', at: '' }
      }

      const parsed = JSON.parse(cached)
      return {
        summary: String(parsed?.summary || ''),
        at: String(parsed?.at || ''),
      }
    } catch {
      return { summary: '', at: '' }
    }
  })
  const [githubUser, setGithubUser] = useState(null)
  const [githubLogin, setGithubLogin] = useState('')
  const [githubAccessToken, setGithubAccessToken] = useState('')
  const [myRepos, setMyRepos] = useState([])
  const [selectedRepoNames, setSelectedRepoNames] = useState([])
  const [repoSearchQuery, setRepoSearchQuery] = useState('')
  const [isLoadingMyRepos, setIsLoadingMyRepos] = useState(false)
  const [isSyncingSelectedRepos, setIsSyncingSelectedRepos] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(true)
  const [isStartingGitHubLogin, setIsStartingGitHubLogin] = useState(false)
  const [isForkSyncing, setIsForkSyncing] = useState(false)
  const [gitSyncMode, setGitSyncMode] = useState('repos')
  const [isTourRunning, setIsTourRunning] = useState(false)
  const [tourSteps, setTourSteps] = useState([])
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia('(max-width: 1024px)').matches)
  const [readingProgress, setReadingProgress] = useState(0)
  const [progressDocId, setProgressDocId] = useState('')
  const [ragIndexStatus, setRagIndexStatus] = useState('Idle')
  const [ragEmbeddingStatus, setRagEmbeddingStatus] = useState('Idle')
  const [chatScope, setChatScope] = useState('section')
  const [chatInput, setChatInput] = useState('')
  const [isChatResponding, setIsChatResponding] = useState(false)
  const [chatStatus, setChatStatus] = useState('Ask a question to start chatting with your docs.')
  const [chatMessages, setChatMessages] = useState([
    {
      id: createClientId(),
      role: 'assistant',
      content: 'I am ready. Ask me about your synced docs and I will answer using retrieved context.',
      citations: [],
    },
  ])
  const [readDocSources, setReadDocSources] = useState(() => {
    try {
      const cached = localStorage.getItem(READ_DOC_SOURCES_STORAGE_KEY)
      if (!cached) {
        return new Set()
      }

      const parsed = JSON.parse(cached)
      if (!Array.isArray(parsed)) {
        return new Set()
      }

      return new Set(parsed.map((value) => String(value)))
    } catch {
      return new Set()
    }
  })
  const lastAutoBackedSyncAtRef = useRef(syncMeta.at || '')
  const hasAttemptedLoginRestoreRef = useRef(false)
  const hasStartedTourRef = useRef(false)
  const tourStartTimeoutRef = useRef(null)
  const libraryPersistTimeoutRef = useRef(null)
  const searchDebounceTimeoutRef = useRef(null)
  const readingProgressRafRef = useRef(null)
  const ragIndexerWorkerRef = useRef(null)
  const ragIndexTimeoutRef = useRef(null)
  const ragIndexRequestIdRef = useRef('')
  const documentPanelRef = useRef(null)
  const chatHistoryRef = useRef(null)

  const isMobileSyncBarVisible = activeView === 'git' && gitSyncMode === 'repos' && Boolean(githubUser)
  const ragIndexTone = getRagStatusTone(ragIndexStatus)
  const ragEmbeddingTone = getRagStatusTone(ragEmbeddingStatus)

  const updateSyncMeta = (summary) => {
    setSyncMeta({
      summary,
      at: new Date().toISOString(),
    })
  }

  const startOnboardingTour = () => {
    if (tourStartTimeoutRef.current) {
      window.clearTimeout(tourStartTimeoutRef.current)
    }

    setActiveView('dashboard')
    setTourSteps(isMobileViewport ? getMobileTourSteps() : getDesktopTourSteps())
    setIsTourRunning(false)

    // Wait for the dashboard DOM to paint before Joyride resolves targets.
    tourStartTimeoutRef.current = window.setTimeout(() => {
      setIsTourRunning(true)
      tourStartTimeoutRef.current = null
    }, 180)
  }

  useEffect(() => {
    return () => {
      if (tourStartTimeoutRef.current) {
        window.clearTimeout(tourStartTimeoutRef.current)
      }

      if (libraryPersistTimeoutRef.current) {
        window.clearTimeout(libraryPersistTimeoutRef.current)
      }

      if (searchDebounceTimeoutRef.current) {
        window.clearTimeout(searchDebounceTimeoutRef.current)
      }

      if (readingProgressRafRef.current !== null) {
        window.cancelAnimationFrame(readingProgressRafRef.current)
      }

      if (ragIndexTimeoutRef.current) {
        window.clearTimeout(ragIndexTimeoutRef.current)
      }

      if (ragIndexerWorkerRef.current) {
        ragIndexerWorkerRef.current.terminate()
      }
    }
  }, [])

  useEffect(() => {
    const worker = new Worker(new URL('./workers/ragIndexer.worker.js', import.meta.url), { type: 'module' })
    ragIndexerWorkerRef.current = worker

    const handleMessage = (event) => {
      const payload = event?.data || {}
      const requestId = String(payload.requestId || '')
      if (!requestId || requestId !== ragIndexRequestIdRef.current) {
        return
      }

      if (payload.type === 'index-progress') {
        const processedDocs = Number(payload.processedDocs || 0)
        const totalDocs = Number(payload.totalDocs || 0)
        setRagIndexStatus(`Indexing ${processedDocs}/${totalDocs} docs...`)
        return
      }

      if (payload.type === 'index-complete') {
        const chunks = Array.isArray(payload.chunks) ? payload.chunks : []
        const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {}
        setRagIndexStatus(`Saving ${chunks.length} chunks...`)
        setRagEmbeddingStatus('Waiting for chunk persistence...')

        writeRagChunksToIndexedDb(chunks, meta)
          .then(async () => {
            setRagIndexStatus(`Ready (${chunks.length} chunks indexed)`)
            if (!chunks.length) {
              setRagEmbeddingStatus('Idle (no chunks to embed)')
              clearRagEmbeddingsFromIndexedDb().catch(() => {
                // Best-effort cleanup.
              })
              return
            }

            try {
              setRagEmbeddingStatus('Preparing embeddings...')
              const result = await syncRagEmbeddingsFromChunks(chunks, ({ processed, total, model }) => {
                setRagEmbeddingStatus(`Embedding ${processed}/${total} chunks (${model})...`)
              })

              setRagEmbeddingStatus(`Ready (${result.total} chunks, ${result.created} new, model: ${result.model})`)
            } catch {
              setRagEmbeddingStatus('Embedding sync failed. Chunks are indexed and embeddings will retry on next update.')
            }
          })
          .catch(() => {
            setRagIndexStatus('RAG index save failed. Your docs are safe; retry on next sync/update.')
            setRagEmbeddingStatus('Idle (waiting for successful indexing)')
          })
        return
      }

      if (payload.type === 'index-error') {
        setRagIndexStatus('RAG indexing failed. It will retry on the next update.')
        setRagEmbeddingStatus('Idle (index not ready)')
      }
    }

    worker.addEventListener('message', handleMessage)

    return () => {
      worker.removeEventListener('message', handleMessage)
      worker.terminate()
      if (ragIndexerWorkerRef.current === worker) {
        ragIndexerWorkerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const hydrateLibrary = async () => {
      try {
        const indexedDbLibrary = await readLibraryFromIndexedDb()
        if (cancelled) {
          return
        }

        if (Array.isArray(indexedDbLibrary)) {
          setLibrary(indexedDbLibrary)
          localStorage.removeItem(STORAGE_KEY)
          setHasHydratedLibrary(true)
          return
        }
      } catch {
        // Fall back to localStorage if IndexedDB is unavailable.
      }

      try {
        const cached = localStorage.getItem(STORAGE_KEY)
        if (!cached) {
          setHasHydratedLibrary(true)
          return
        }

        const parsed = JSON.parse(cached)
        if (Array.isArray(parsed)) {
          setLibrary(parsed)
          writeLibraryToIndexedDb(parsed)
            .then(() => {
              // Keep localStorage only as a legacy import source and clear it after migration.
              localStorage.removeItem(STORAGE_KEY)
            })
            .catch(() => {
              // Best-effort migration from localStorage to IndexedDB.
            })
        }
        setHasHydratedLibrary(true)
      } catch {
        setError('Could not read saved library. You can re-upload your files.')
        setHasHydratedLibrary(true)
      }
    }

    hydrateLibrary()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hasHydratedLibrary) {
      return
    }

    if (libraryPersistTimeoutRef.current) {
      window.clearTimeout(libraryPersistTimeoutRef.current)
    }

    // Debounce large IndexedDB writes to avoid blocking during rapid state updates.
    libraryPersistTimeoutRef.current = window.setTimeout(() => {
      writeLibraryToIndexedDb(library)
        .then(() => {
          setStorageWarning('')
        })
        .catch(() => {
          setStorageWarning('Storage is full. Export your library or clear unused docs to avoid data loss.')
        })
    }, 350)

    return () => {
      if (libraryPersistTimeoutRef.current) {
        window.clearTimeout(libraryPersistTimeoutRef.current)
      }
    }
  }, [library, hasHydratedLibrary])

  useEffect(() => {
    if (!hasHydratedLibrary) {
      return
    }

    if (!ragIndexerWorkerRef.current) {
      return
    }

    if (ragIndexTimeoutRef.current) {
      window.clearTimeout(ragIndexTimeoutRef.current)
    }

    const markdownDocs = library
      .flatMap((section) => section.docs || [])
      .filter((doc) => isMarkdownLikeDoc(doc))
      .map((doc) => ({
        id: doc.id,
        title: doc.title,
        section: doc.section,
        source: doc.source,
        sourceRepo: doc.sourceRepo,
        format: doc.format,
        content: doc.content,
      }))

    if (!markdownDocs.length) {
      setRagIndexStatus('Idle (no markdown docs to index)')
      setRagEmbeddingStatus('Idle (no markdown docs)')
      clearRagChunksFromIndexedDb().catch(() => {
        // Best-effort cleanup.
      })
      clearRagEmbeddingsFromIndexedDb().catch(() => {
        // Best-effort cleanup.
      })
      return
    }

    ragIndexTimeoutRef.current = window.setTimeout(() => {
      const requestId = createClientId()
      ragIndexRequestIdRef.current = requestId
      setRagIndexStatus('Preparing RAG index...')
      ragIndexerWorkerRef.current?.postMessage({
        type: 'index-library',
        requestId,
        docs: markdownDocs,
      })
    }, 600)

    return () => {
      if (ragIndexTimeoutRef.current) {
        window.clearTimeout(ragIndexTimeoutRef.current)
      }
    }
  }, [library, hasHydratedLibrary])

  useEffect(() => {
    if (searchDebounceTimeoutRef.current) {
      window.clearTimeout(searchDebounceTimeoutRef.current)
    }

    // Debounce query updates so large-content filtering doesn't run on every keystroke.
    searchDebounceTimeoutRef.current = window.setTimeout(() => {
      setDeferredDashboardSearchQuery(dashboardSearchQuery)
    }, 180)

    return () => {
      if (searchDebounceTimeoutRef.current) {
        window.clearTimeout(searchDebounceTimeoutRef.current)
      }
    }
  }, [dashboardSearchQuery])

  useEffect(() => {
    localStorage.setItem(SYNC_META_STORAGE_KEY, JSON.stringify(syncMeta))
  }, [syncMeta])

  useEffect(() => {
    localStorage.setItem(READ_DOC_SOURCES_STORAGE_KEY, JSON.stringify(Array.from(readDocSources)))
  }, [readDocSources])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 1024px)')

    const updateViewport = () => {
      setIsMobileViewport(mediaQuery.matches)
    }

    updateViewport()
    mediaQuery.addEventListener('change', updateViewport)

    return () => {
      mediaQuery.removeEventListener('change', updateViewport)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const checkStorage = async () => {
      if (!navigator.storage?.estimate) {
        return
      }

      try {
        const estimate = await navigator.storage.estimate()
        if (cancelled) {
          return
        }

        const usage = Number(estimate.usage || 0)
        const quota = Number(estimate.quota || 0)

        if (quota > 0 && usage / quota >= 0.85) {
          setStorageWarning('Storage is above 85%. Export or clear docs to prevent sync/import failures.')
        }
      } catch {
        // Ignore estimate failures on unsupported browsers.
      }
    }

    checkStorage()
    return () => {
      cancelled = true
    }
  }, [library])

  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, activeView)
  }, [activeView])

  useEffect(() => {
    setIsSectionsPanelOpen(false)
  }, [activeView])

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setIsAuthLoading(false)
      return
    }

    let mounted = true
    const cachedProviderToken = sessionStorage.getItem(GH_PROVIDER_TOKEN_STORAGE_KEY)

    const hydrateAuth = async () => {
      const { data } = await supabase.auth.getSession()
      if (!mounted) {
        return
      }

      const session = data.session
      setGithubUser(session?.user ?? null)
      setGithubLogin(getGitHubLoginFromSupabaseUser(session?.user))

      const providerToken = session?.provider_token || cachedProviderToken || ''
      setGithubAccessToken(providerToken)
      if (providerToken) {
        sessionStorage.setItem(GH_PROVIDER_TOKEN_STORAGE_KEY, providerToken)
      }

      setIsAuthLoading(false)
    }

    hydrateAuth()

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) {
        return
      }

      setGithubUser(session?.user ?? null)
      setGithubLogin(getGitHubLoginFromSupabaseUser(session?.user))

      if (session?.provider_token) {
        setGithubAccessToken(session.provider_token)
        sessionStorage.setItem(GH_PROVIDER_TOKEN_STORAGE_KEY, session.provider_token)

        const postAuthView = sessionStorage.getItem(POST_AUTH_VIEW_KEY)
        if (postAuthView) {
          setActiveView(normalizeView(postAuthView))
          sessionStorage.removeItem(POST_AUTH_VIEW_KEY)
        }
      } else if (!session) {
        setGithubAccessToken('')
        setGithubLogin('')
        hasAttemptedLoginRestoreRef.current = false
        sessionStorage.removeItem(GH_PROVIDER_TOKEN_STORAGE_KEY)
      }
    })

    return () => {
      mounted = false
      authListener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!githubUser || isAuthLoading || hasStartedTourRef.current) {
      return
    }

    const hasLegacyDone = localStorage.getItem(DESKTOP_TOUR_DONE_KEY) === '1' || localStorage.getItem(MOBILE_TOUR_DONE_KEY) === '1'
    if (hasLegacyDone && localStorage.getItem(TOUR_DONE_KEY) !== '1') {
      localStorage.setItem(TOUR_DONE_KEY, '1')
    }

    const hasAutoShown = localStorage.getItem(TOUR_AUTO_SHOWN_KEY) === '1'
    if (hasAutoShown || localStorage.getItem(TOUR_DONE_KEY) === '1') {
      if (!hasAutoShown && localStorage.getItem(TOUR_DONE_KEY) === '1') {
        localStorage.setItem(TOUR_AUTO_SHOWN_KEY, '1')
      }
      return
    }

    hasStartedTourRef.current = true
    localStorage.setItem(TOUR_AUTO_SHOWN_KEY, '1')
    startOnboardingTour()
  }, [githubUser, isAuthLoading, isMobileViewport])

  useEffect(() => {
    if (activeView !== 'chat') {
      return
    }

    const historyElement = chatHistoryRef.current
    if (!historyElement) {
      return
    }

    historyElement.scrollTop = historyElement.scrollHeight
  }, [activeView, chatMessages, isChatResponding])

  const onTourCallback = (data) => {
    const status = String(data?.status || '')
    const action = String(data?.action || '')

    if (status === 'finished' || status === 'skipped' || action === 'close') {
      localStorage.setItem(TOUR_DONE_KEY, '1')
      setIsTourRunning(false)
    }
  }

  const allDocs = useMemo(() => {
    return library.flatMap((section) => section.docs)
  }, [library])

  const filteredLibrary = useMemo(() => {
    const query = deferredDashboardSearchQuery.trim().toLowerCase()
    if (!query) {
      return library
    }

    return library
      .map((section) => {
        const matchingDocs = section.docs.filter((doc) => {
          const searchable = [doc.title, doc.section, doc.sourceRepo, doc.source, doc.content].join(' ').toLowerCase()
          return searchable.includes(query)
        })

        return {
          ...section,
          docs: matchingDocs,
        }
      })
      .filter((section) => section.docs.length > 0)
  }, [library, deferredDashboardSearchQuery])

  const filteredDocsCount = useMemo(() => {
    return filteredLibrary.reduce((total, section) => total + section.docs.length, 0)
  }, [filteredLibrary])

  const repoGroups = useMemo(() => {
    const groups = new Map()

    for (const section of filteredLibrary) {
      const repo = section.sourceRepo || 'Local Uploads'
      if (!groups.has(repo)) {
        groups.set(repo, [])
      }
      groups.get(repo).push(section)
    }

    return Array.from(groups.entries())
      .map(([repo, sections]) => ({
        repo,
        sections: sections.sort(sectionSort),
      }))
      .sort((a, b) => a.repo.localeCompare(b.repo))
  }, [filteredLibrary])

  useEffect(() => {
    if (!allDocs.length) {
      setSelectedDocId('')
      return
    }

    const docStillExists = allDocs.some((doc) => doc.id === selectedDocId)
    if (!docStillExists) {
      setSelectedDocId(allDocs[0].id)
    }
  }, [allDocs, selectedDocId])

  const selectedDoc = useMemo(() => {
    return allDocs.find((doc) => doc.id === selectedDocId) || null
  }, [allDocs, selectedDocId])

  const [selectedPdfPages, setSelectedPdfPages] = useState([])
  const [isPdfPageRendering, setIsPdfPageRendering] = useState(false)
  const [pdfRenderError, setPdfRenderError] = useState('')

  useEffect(() => {
    if (!selectedDoc || !isPdfDoc(selectedDoc) || !selectedDoc.pdfBase64) {
      setSelectedPdfPages([])
      setIsPdfPageRendering(false)
      setPdfRenderError('')
      return
    }

    let cancelled = false

    const renderPdfPages = async () => {
      setPdfRenderError('')
      setIsPdfPageRendering(true)

      try {
        const pdfBytes = decodeBase64ToBytes(selectedDoc.pdfBase64)
        const panelWidth = documentPanelRef.current?.clientWidth || window.innerWidth
        const contentWidth = Math.max(320, Math.min(1400, panelWidth - 72))
        const pageImages = await renderPdfPagesToDataUrls(pdfBytes, contentWidth)

        if (!cancelled) {
          setSelectedPdfPages(pageImages)
        }
      } catch (err) {
        if (!cancelled) {
          setSelectedPdfPages([])
          const message = err instanceof Error ? err.message : 'Could not render PDF on this device.'
          setPdfRenderError(message)
        }
      } finally {
        if (!cancelled) {
          setIsPdfPageRendering(false)
        }
      }
    }

    renderPdfPages()

    return () => {
      cancelled = true
    }
  }, [selectedDoc])

  const selectedDocReadStats = useMemo(() => {
    if (isPdfDoc(selectedDoc)) {
      return {
        wordCount: 0,
        readTimeLabel: 'PDF document',
      }
    }

    const wordCount = getWordCount(selectedDoc?.content || '')
    return {
      wordCount,
      readTimeLabel: formatReadTimeFromWords(wordCount),
    }
  }, [selectedDoc])

  useEffect(() => {
    const panel = documentPanelRef.current
    if (!panel) {
      return
    }

    const resetProgress = () => {
      if (readingProgressRafRef.current !== null) {
        window.cancelAnimationFrame(readingProgressRafRef.current)
        readingProgressRafRef.current = null
      }
      setReadingProgress(0)
      setProgressDocId('')
    }

    if (activeView !== 'dashboard' || !selectedDoc) {
      resetProgress()
      return
    }

    const applyProgress = () => {
      setProgressDocId(selectedDoc.id)
      const totalScrollable = panel.scrollHeight - panel.clientHeight
      if (totalScrollable <= 0) {
        setReadingProgress(100)
        return
      }

      const nextProgress = Math.min(100, Math.max(0, Math.round((panel.scrollTop / totalScrollable) * 100)))
      setReadingProgress(nextProgress)
    }

    const updateProgress = () => {
      if (readingProgressRafRef.current !== null) {
        return
      }

      readingProgressRafRef.current = window.requestAnimationFrame(() => {
        readingProgressRafRef.current = null
        applyProgress()
      })
    }

    panel.scrollTop = 0
    updateProgress()
    panel.addEventListener('scroll', updateProgress, { passive: true })

    return () => {
      panel.removeEventListener('scroll', updateProgress)
      if (readingProgressRafRef.current !== null) {
        window.cancelAnimationFrame(readingProgressRafRef.current)
        readingProgressRafRef.current = null
      }
    }
  }, [activeView, selectedDocId, selectedDoc])

  useEffect(() => {
    if (activeView !== 'dashboard' || !selectedDoc || readingProgress < 100 || progressDocId !== selectedDoc.id) {
      return
    }

    const sourceKey = String(selectedDoc.source || '').trim()
    if (!sourceKey) {
      return
    }

    setReadDocSources((previous) => {
      if (previous.has(sourceKey)) {
        return previous
      }

      const next = new Set(previous)
      next.add(sourceKey)
      return next
    })
  }, [activeView, selectedDoc, readingProgress, progressDocId])

  const isDocRead = (doc) => {
    const sourceKey = String(doc?.source || '').trim()
    return sourceKey ? readDocSources.has(sourceKey) : false
  }

  const markDocUnread = (doc) => {
    const sourceKey = String(doc?.source || '').trim()
    if (!sourceKey) {
      return
    }

    setReadDocSources((previous) => {
      if (!previous.has(sourceKey)) {
        return previous
      }

      const next = new Set(previous)
      next.delete(sourceKey)
      return next
    })
  }

  const filteredMyRepos = useMemo(() => {
    const query = repoSearchQuery.trim().toLowerCase()
    if (!query) {
      return myRepos
    }

    return myRepos.filter((repo) => {
      const fullName = repo.fullName.toLowerCase()
      const description = String(repo.description || '').toLowerCase()
      return fullName.includes(query) || description.includes(query)
    })
  }, [myRepos, repoSearchQuery])

  const docsByRepoAndPath = useMemo(() => {
    const repoMap = new Map()

    for (const doc of allDocs) {
      const location = parseDocLocation(doc)
      if (!location.path) {
        continue
      }

      if (!repoMap.has(location.repoKey)) {
        repoMap.set(location.repoKey, new Map())
      }

      const pathMap = repoMap.get(location.repoKey)
      for (const variant of getPathVariants(location.path)) {
        const key = variant.toLowerCase()
        if (!pathMap.has(key)) {
          pathMap.set(key, doc)
        }
      }
    }

    return repoMap
  }, [allDocs])

  const markdownComponents = useMemo(() => {
    const externalPattern = /^(https?:|mailto:|tel:)/i

    const findInternalDoc = (href) => {
      const trimmedHref = String(href || '').trim()
      if (!trimmedHref || externalPattern.test(trimmedHref) || trimmedHref.startsWith('#')) {
        return null
      }

      const { path: rawPath } = splitHref(trimmedHref)
      if (!rawPath) {
        return null
      }

      let decodedPath = rawPath
      try {
        decodedPath = decodeURIComponent(rawPath)
      } catch {
        decodedPath = rawPath
      }

      const selectedLocation = parseDocLocation(selectedDoc)
      const fromRoot = decodedPath.startsWith('/')
      const absolutePath = fromRoot
        ? normalizeDocPath(decodedPath.slice(1))
        : resolveRelativePath(selectedLocation.path, decodedPath)

      const candidates = getPathVariants(absolutePath).map((value) => value.toLowerCase())
      if (!candidates.length) {
        return null
      }

      const selectedRepoPathMap = docsByRepoAndPath.get(selectedLocation.repoKey)
      if (selectedRepoPathMap) {
        for (const candidate of candidates) {
          if (selectedRepoPathMap.has(candidate)) {
            return selectedRepoPathMap.get(candidate)
          }
        }
      }

      for (const pathMap of docsByRepoAndPath.values()) {
        for (const candidate of candidates) {
          if (pathMap.has(candidate)) {
            return pathMap.get(candidate)
          }
        }
      }

      return null
    }

    return {
      a: ({ href, children, ...props }) => {
        const internalDoc = findInternalDoc(href)
        if (internalDoc) {
          return (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                event.preventDefault()
                setError('')
                setActiveView('dashboard')
                setSelectedDocId(internalDoc.id)
              }}
            >
              {children}
            </a>
          )
        }

        const isExternal = externalPattern.test(String(href || ''))
        return (
          <a {...props} href={href} target={isExternal ? '_blank' : undefined} rel={isExternal ? 'noreferrer' : undefined}>
            {children}
          </a>
        )
      },
      table: ({ children, ...props }) => {
        return (
          <div className="markdown-table-wrap">
            <table {...props}>{children}</table>
          </div>
        )
      },
    }
  }, [docsByRepoAndPath, selectedDoc, setActiveView, setError, setSelectedDocId])

  const onUploadFiles = async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''

    const supportedFiles = files.filter((file) => SUPPORTED_LOCAL_DOC_PATTERN.test(file.name))

    if (!supportedFiles.length) {
      setError('Please upload supported files with .md, .mdx, or .pdf extensions.')
      return
    }

    setError('')

    try {
      const docs = await Promise.all(
        supportedFiles.map(async (file) => {
          const content = await getFileContent(file)

          if (PDF_DOC_PATTERN.test(file.name)) {
            return {
              id: `${toSlug(file.name)}-${createClientId()}`,
              title: getTitleFromFile(file),
              section: getSectionFromFile(file),
              sourceRepo: 'Local Uploads',
              source: file.webkitRelativePath || file.name,
              format: 'pdf',
              mimeType: file.type || 'application/pdf',
              pdfBase64: await getLocalPdfBase64(file),
              content,
              updatedAt: new Date().toISOString(),
            }
          }

          return {
            id: `${toSlug(file.name)}-${createClientId()}`,
            title: getTitleFromFile(file),
            section: getSectionFromFile(file),
            sourceRepo: 'Local Uploads',
            source: file.webkitRelativePath || file.name,
            format: 'markdown',
            content,
            updatedAt: new Date().toISOString(),
          }
        }),
      )

      setLibrary((previous) => mergeDocsIntoLibrary(previous, docs))
      setActiveView('dashboard')
      setIsSectionsPanelOpen(false)
      setRepoStatus(`Imported ${docs.length} local file${docs.length === 1 ? '' : 's'}.`)
      updateSyncMeta(`Imported ${docs.length} local file${docs.length === 1 ? '' : 's'}`)
    } catch (uploadError) {
      console.error(uploadError)
      setError('Failed to parse one or more files. Check the file and try again.')
    }
  }

  const pullGitHubRepo = async () => {
    if (!githubAccessToken) {
      setError('Login with GitHub first to pull repositories (bypasses rate limits).')
      setRepoStatus('Tap "Login with GitHub" in the Sync section above to authenticate.')
      return
    }

    const parsedRepo = parseGitHubRepo(repoInput)
    if (!parsedRepo) {
      setError('Enter a valid GitHub repository URL, .git URL, or owner/repo.')
      return
    }

    setError('')
    setRepoStatus('Checking repository...')
    setIsPullingRepo(true)

    try {
      const { docs, markdownCount, importedCount } = await fetchMarkdownDocsFromRepo({
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        token: githubAccessToken,
      })

      setLibrary((previous) => mergeDocsIntoLibrary(previous, docs))

      const truncatedNote = markdownCount > importedCount ? ` Imported first ${importedCount} files.` : ''
      setRepoStatus(`Imported ${docs.length} files from ${parsedRepo.owner}/${parsedRepo.repo}.${truncatedNote}`)
      updateSyncMeta(`Imported ${docs.length} docs from ${parsedRepo.owner}/${parsedRepo.repo}`)
      setActiveView('dashboard')
      setIsSectionsPanelOpen(false)
    } catch (repoError) {
      const message = explainGitHubError(repoError, 'Could not pull repository docs.')
      setError(message)
      setRepoStatus('')
    } finally {
      setIsPullingRepo(false)
    }
  }

  const signInWithGitHub = async () => {
    if (!isSupabaseConfigured || !supabase) {
      setError('Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
      return
    }

    setError('')
    setIsStartingGitHubLogin(true)
    sessionStorage.setItem(POST_AUTH_VIEW_KEY, 'git')

    try {
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          redirectTo: window.location.origin,
          scopes: 'public_repo repo read:user',
        },
      })

      if (signInError) {
        throw signInError
      }
    } catch {
      setError('Could not start GitHub login. Check Supabase provider settings and try again.')
      setIsStartingGitHubLogin(false)
      setRepoStatus('')
    } finally {
      setIsStartingGitHubLogin(false)
    }
  }

  const signOutGitHub = async () => {
    if (!supabase) {
      return
    }

    const librarySnapshot = library
    try {
      writeLibraryToIndexedDb(librarySnapshot).catch(() => {
        // Best-effort persistence while signing out.
      })
    } catch {
      // Ignore persistence errors during sign-out; docs remain in-memory for this session.
    }

    await supabase.auth.signOut()
    setGithubUser(null)
    setGithubLogin('')
    setGithubAccessToken('')
    setMyRepos([])
    setSelectedRepoNames([])
    setRepoSearchQuery('')
    setActiveView('dashboard')
    setLibrary((previous) => (previous.length ? previous : librarySnapshot))
    hasAttemptedLoginRestoreRef.current = false
    sessionStorage.removeItem(GH_PROVIDER_TOKEN_STORAGE_KEY)
    setRepoStatus('Disconnected GitHub account. Synced docs remain in your local library.')
  }

  const loadMyRepos = async ({ preserveSelection = true, statusPrefix = 'Loading your repositories...' } = {}) => {
    if (!githubAccessToken) {
      setError('Login with GitHub first.')
      return
    }

    setError('')
    setRepoStatus(statusPrefix)
    setIsLoadingMyRepos(true)

    try {
      const repos = await fetchUserRepos(githubAccessToken)
      setMyRepos(repos)
      setSelectedRepoNames((previous) =>
        preserveSelection ? previous.filter((name) => repos.some((repo) => repo.fullName === name)) : [],
      )
      setRepoStatus(`Loaded ${repos.length} repositories. Search and select repositories to sync.`)
    } catch (reposError) {
      setRepoStatus('')
      setError(explainGitHubError(reposError, 'Could not load repositories from your account.'))
    } finally {
      setIsLoadingMyRepos(false)
    }
  }

  useEffect(() => {
    if (!githubUser || !githubAccessToken) {
      return
    }

    if (myRepos.length || isLoadingMyRepos) {
      return
    }

    loadMyRepos({ preserveSelection: false, statusPrefix: 'Connected. Loading your repositories...' })
  }, [githubUser, githubAccessToken, myRepos.length, isLoadingMyRepos])

  const toggleRepoSelection = (fullName) => {
    setSelectedRepoNames((previous) => {
      if (previous.includes(fullName)) {
        return previous.filter((value) => value !== fullName)
      }
      return [...previous, fullName]
    })
  }

  const syncSelectedRepos = async () => {
    if (!githubAccessToken) {
      setError('Login with GitHub first.')
      return
    }

    if (!selectedRepoNames.length) {
      setError('Select at least one repository to sync.')
      return
    }

    setError('')
    setIsSyncingSelectedRepos(true)

    let syncedRepoCount = 0
    let importedDocsCount = 0
    let skippedNoDocsCount = 0
    const failedRepos = []
    const mergedDocs = []

    try {
      for (let index = 0; index < selectedRepoNames.length; index += 1) {
        const fullName = selectedRepoNames[index]
        const [owner, repo] = fullName.split('/')
        setRepoStatus(`Syncing ${index + 1}/${selectedRepoNames.length}: ${fullName}`)

        try {
          const { docs } = await fetchMarkdownDocsFromRepo({ owner, repo, token: githubAccessToken })
          mergedDocs.push(...docs)
          syncedRepoCount += 1
          importedDocsCount += docs.length
        } catch (repoError) {
          if (repoError instanceof Error && repoError.message.includes('No markdown files found')) {
            skippedNoDocsCount += 1
            continue
          }
          failedRepos.push(fullName)
        }
      }

      if (mergedDocs.length) {
        setLibrary((previous) => mergeDocsIntoLibrary(previous, mergedDocs))
        setActiveView('dashboard')
      }

      const failuresSuffix = failedRepos.length ? ` Failed: ${failedRepos.join(', ')}.` : ''
      setRepoStatus(
        `Sync complete. Synced ${syncedRepoCount} repos, imported ${importedDocsCount} docs, skipped ${skippedNoDocsCount} repos with no docs.${failuresSuffix}`,
      )
      updateSyncMeta(`Synced ${syncedRepoCount} repos and imported ${importedDocsCount} docs`)
    } finally {
      setIsSyncingSelectedRepos(false)
    }
  }

  const forkAndSyncRepo = async () => {
    if (!githubUser) {
      setError('Login with GitHub first.')
      return
    }

    if (!githubLogin) {
      setError('Could not determine your GitHub username from login. Sign out and login again.')
      return
    }

    if (!githubAccessToken) {
      setError('GitHub access token is missing in session. Sign out and login again.')
      return
    }

    const parsedRepo = parseGitHubRepo(repoInput)
    if (!parsedRepo) {
      setError('Enter a valid GitHub repository URL or owner/repo.')
      return
    }

    setError('')
    setRepoStatus('Creating or updating fork...')
    setIsForkSyncing(true)

    try {
      await githubRequest(`/repos/${parsedRepo.owner}/${parsedRepo.repo}/forks`, githubAccessToken, {
        method: 'POST',
      })

      await waitForForkAvailability({
        owner: githubLogin,
        repo: parsedRepo.repo,
        token: githubAccessToken,
      })

      setRepoStatus(`Syncing docs from ${githubLogin}/${parsedRepo.repo}...`)

      const { docs, markdownCount, importedCount } = await fetchMarkdownDocsFromRepo({
        owner: githubLogin,
        repo: parsedRepo.repo,
        token: githubAccessToken,
      })

      setLibrary((previous) => mergeDocsIntoLibrary(previous, docs))
      setActiveView('dashboard')

      const truncatedNote = markdownCount > importedCount ? ` Imported first ${importedCount} files.` : ''
      setRepoStatus(`Fork synced. Imported ${docs.length} files from ${githubLogin}/${parsedRepo.repo}.${truncatedNote}`)
      updateSyncMeta(`Fork synced ${githubLogin}/${parsedRepo.repo} with ${docs.length} docs`)
    } catch (syncError) {
      setRepoStatus('')
      setError(explainGitHubError(syncError, 'Could not fork and sync this repository.'))
    } finally {
      setIsForkSyncing(false)
    }
  }

  const clearLibrary = () => {
    setLibrary([])
    setSelectedDocId('')
    setError('')
    localStorage.removeItem(STORAGE_KEY)
    deleteLibraryFromIndexedDb().catch(() => {
      // Ignore clear failures; local state is already reset.
    })
    clearRagChunksFromIndexedDb().catch(() => {
      // Ignore clear failures; local state is already reset.
    })
    clearRagEmbeddingsFromIndexedDb().catch(() => {
      // Ignore clear failures; local state is already reset.
    })
    setRagIndexStatus('Idle')
    setRagEmbeddingStatus('Idle')
  }

  const runChatWithRag = async () => {
    const question = String(chatInput || '').trim()
    if (!question) {
      setChatStatus('Enter a question first.')
      return
    }

    const scopeSection = chatScope === 'section' ? String(selectedDoc?.section || '') : ''
    if (chatScope === 'section' && !scopeSection) {
      setChatStatus('Open a document first for section scope, or switch to Library scope.')
      return
    }

    const userMessage = {
      id: createClientId(),
      role: 'user',
      content: question,
      citations: [],
    }

    setChatMessages((previous) => [...previous, userMessage])
    setChatInput('')
    setIsChatResponding(true)
    setChatStatus('Checking RAG cache...')

    try {
      const chunks = await readAllRagChunksFromIndexedDb()
      if (!chunks.length) {
        setChatStatus('RAG index is still preparing. Please wait a few seconds and try again.')
        setChatMessages((previous) => [
          ...previous,
          {
            id: createClientId(),
            role: 'assistant',
            content: 'I do not see indexed chunks yet. This can happen right after restore while indexing is still running.',
            citations: [],
          },
        ])
        return
      }

      const scopedChunks = scopeSection
        ? chunks.filter((chunk) => String(chunk.section || '').toLowerCase() === scopeSection.toLowerCase())
        : chunks

      const effectiveChunks = scopedChunks.length ? scopedChunks : chunks
      const didFallbackToWholeLibrary = Boolean(scopeSection && !scopedChunks.length)

      if (didFallbackToWholeLibrary) {
        setChatStatus(`No chunks were found in section "${scopeSection}". Falling back to Library...`)
      }

      const activeModel = getEmbeddingModelName()
      const embeddings = await readAllRagEmbeddingsFromIndexedDb()
      const hasScopedEmbeddings = embeddings.some(
        (record) => record?.model === activeModel && effectiveChunks.some((chunk) => chunk.chunkId === record.chunkId),
      )

      if (!hasScopedEmbeddings) {
        setChatStatus(`Preparing embeddings for ${effectiveChunks.length} chunks...`)
        const embedResult = await syncRagEmbeddingsFromChunks(effectiveChunks, ({ processed, total, model }) => {
          setChatStatus(`Embedding ${processed}/${total} chunks (${model})...`)
        })
        setRagEmbeddingStatus(`Ready (${embedResult.total} chunks, ${embedResult.created} new, model: ${embedResult.model})`)
      }

      setChatStatus('Retrieving relevant context...')
      const retrieval = await retrieveRagTopChunks({
        query: question,
        topK: 6,
        scopeSection: didFallbackToWholeLibrary ? '' : scopeSection,
      })

      if (!retrieval.results.length) {
        setChatStatus(`No relevant chunks found (model: ${retrieval.model}).`)
        setChatMessages((previous) => [
          ...previous,
          {
            id: createClientId(),
            role: 'assistant',
            content: 'I could not find relevant context for that question. Try rephrasing, switching scope, or syncing more docs.',
            citations: [],
          },
        ])
        return
      }

      setChatStatus('Generating grounded answer...')
      const answer = await askGroqWithContext({ question, chunks: retrieval.results })
      const citations = retrieval.results.map((item) => ({
        chunkId: item.chunkId,
        docId: item.docId,
        title: item.title,
        section: item.section,
        score: item.score,
      }))

      setChatMessages((previous) => [
        ...previous,
        {
          id: createClientId(),
          role: 'assistant',
          content: answer,
          citations,
        },
      ])
      setChatStatus(`Answered using ${retrieval.results.length} chunks (${retrieval.model}).`)
    } catch {
      setChatStatus('Chat generation failed. Please retry.')
      setChatMessages((previous) => [
        ...previous,
        {
          id: createClientId(),
          role: 'assistant',
          content: 'I hit an error while generating the answer. Please try again.',
          citations: [],
        },
      ])
    } finally {
      setIsChatResponding(false)
    }
  }

  const clearChatConversation = () => {
    setChatMessages([
      {
        id: createClientId(),
        role: 'assistant',
        content: 'Conversation reset. Ask a new question and I will use your indexed docs as context.',
        citations: [],
      },
    ])
    setChatStatus('Chat cleared.')
  }

  const exportLibrary = () => {
    const payload = JSON.stringify(library, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)

    const link = document.createElement('a')
    link.href = url
    link.download = 'docs-library.json'
    link.click()

    URL.revokeObjectURL(url)
  }

  const importLibrary = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    try {
      const data = JSON.parse(await file.text())
      if (!Array.isArray(data)) {
        throw new Error('Invalid format')
      }

      setLibrary(data)
      setError('')
    } catch {
      setError('Could not import library. Use a valid docs-library.json file.')
    }
  }

  const ensureBackupRepo = async () => {
    if (!githubLogin) {
      throw new Error('GitHub username is missing. Disconnect and login again.')
    }

    try {
      await githubRequest(`/repos/${githubLogin}/${BACKUP_REPO_NAME}`, githubAccessToken)
      return
    } catch (repoCheckError) {
      const message = repoCheckError instanceof Error ? repoCheckError.message : String(repoCheckError)
      if (!message.includes('404')) {
        throw repoCheckError
      }
    }

    await githubRequest('/user/repos', githubAccessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: BACKUP_REPO_NAME,
        private: true,
        auto_init: true,
        description: 'Backup repository used by Docs Hub',
      }),
    })
  }

  const backupLibraryToRepo = async (payloadContent) => {
    await ensureBackupRepo()

    let existingSha = ''
    try {
      const existing = await githubRequest(
        `/repos/${githubLogin}/${BACKUP_REPO_NAME}/contents/${encodeRepoPath(BACKUP_REPO_FILE)}`,
        githubAccessToken,
      )
      existingSha = existing?.sha || ''
    } catch {
      existingSha = ''
    }

    await githubRequest(`/repos/${githubLogin}/${BACKUP_REPO_NAME}/contents/${encodeRepoPath(BACKUP_REPO_FILE)}`, githubAccessToken, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Backup docs library at ${new Date().toISOString()}`,
        content: encodeGitHubContent(payloadContent),
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    })
  }

  const restoreLibraryFromRepo = async () => {
    if (!githubLogin) {
      throw new Error('GitHub username is missing. Disconnect and login again.')
    }

    const fileData = await githubRequest(
      `/repos/${githubLogin}/${BACKUP_REPO_NAME}/contents/${encodeRepoPath(BACKUP_REPO_FILE)}`,
      githubAccessToken,
    )

    let encodedContent = fileData?.content || ''

    if (!encodedContent && fileData?.sha) {
      const blobData = await githubRequest(
        `/repos/${githubLogin}/${BACKUP_REPO_NAME}/git/blobs/${fileData.sha}`,
        githubAccessToken,
      )
      encodedContent = String(blobData?.content || '')
    }

    if (encodedContent) {
      return decodeGitHubContent(encodedContent)
    }

    if (fileData?.download_url) {
      const backupBytes = await fetchGitHubBinaryFromDownloadUrl(fileData.download_url, githubAccessToken)
      if (backupBytes) {
        return new TextDecoder('utf-8').decode(backupBytes)
      }
    }

    throw new Error('Backup file could not be downloaded from GitHub.')
  }

  const backupLibraryToGitHub = async ({ silent = false } = {}) => {
    if (!githubAccessToken) {
      if (!silent) {
        setError('Login with GitHub first to backup to cloud.')
      }
      return false
    }

    if (!silent) {
      setError('')
      setCloudBackupStatus('Saving backup to GitHub...')
    }
    setIsBackingUpCloud(true)
    let isSuccess = false

    try {
      const payload = {
        savedAt: new Date().toISOString(),
        docCount: allDocs.length,
        library,
      }
      const content = JSON.stringify(payload, null, 2)

      await backupLibraryToRepo(content)
      isSuccess = true
      setCloudBackupStatus(`${silent ? 'Auto backup' : 'Cloud backup'} saved (${allDocs.length} docs) to backup repository.`)
    } catch (backupError) {
      const backupMessage = explainGitHubError(backupError, 'Could not save backup to GitHub.')
      setCloudBackupStatus(silent ? 'Auto backup failed. You can retry manually.' : backupMessage)
      if (!silent) {
        setError(backupMessage)
      }
    } finally {
      setIsBackingUpCloud(false)
    }

    return isSuccess
  }

  const restoreLibraryFromGitHub = async ({ silent = false, fromLogin = false } = {}) => {
    if (!githubAccessToken) {
      if (!silent) {
        setError('Login with GitHub first to restore from cloud.')
      }
      return
    }

    if (!silent) {
      setError('')
    }
    setCloudBackupStatus(fromLogin ? 'Login detected. Restoring cloud backup...' : 'Restoring backup from GitHub...')
    setIsRestoringCloud(true)

    try {
      const content = await restoreLibraryFromRepo()

      const parsed = JSON.parse(content)
      const restoredLibrary = Array.isArray(parsed) ? parsed : parsed?.library

      if (!Array.isArray(restoredLibrary)) {
        throw new Error('Backup format is invalid.')
      }

      setLibrary(restoredLibrary)
      setSelectedDocId('')
      setActiveView('dashboard')
      setCloudBackupStatus(
        `Cloud restore complete (${restoredLibrary.flatMap((section) => section.docs || []).length} docs) from backup repository.`,
      )
    } catch (restoreError) {
      const message = restoreError instanceof Error ? restoreError.message.toLowerCase() : ''
      const isMissingBackup = message.includes('404') || message.includes('not found')

      if (isMissingBackup) {
        setCloudBackupStatus(fromLogin ? 'No cloud backup found yet. Sync docs and backup to create one.' : 'No cloud backup found yet.')
      } else {
        const restoreMessage = explainGitHubError(restoreError, 'Could not restore backup from GitHub.')
        setCloudBackupStatus(restoreMessage)
        if (!silent) {
          setError(restoreMessage)
        }
      }
    } finally {
      setIsRestoringCloud(false)
    }
  }

  const deleteCloudBackupFromGitHub = async () => {
    if (!githubAccessToken) {
      setError('Login with GitHub first to manage cloud backups.')
      return
    }

    const confirmed = window.confirm('Delete cloud backup from GitHub? This cannot be undone.')
    if (!confirmed) {
      return
    }

    setError('')
    setCloudBackupStatus('Deleting cloud backup...')
    setIsDeletingCloudBackup(true)

    try {
      let deleted = false

      if (githubLogin) {
        try {
          const fileData = await githubRequest(
            `/repos/${githubLogin}/${BACKUP_REPO_NAME}/contents/${encodeRepoPath(BACKUP_REPO_FILE)}`,
            githubAccessToken,
          )

          if (fileData?.sha) {
            await githubRequest(
              `/repos/${githubLogin}/${BACKUP_REPO_NAME}/contents/${encodeRepoPath(BACKUP_REPO_FILE)}`,
              githubAccessToken,
              {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  message: `Delete backup at ${new Date().toISOString()}`,
                  sha: fileData.sha,
                }),
              },
            )
            deleted = true
          }
        } catch (repoDeleteError) {
          const message = repoDeleteError instanceof Error ? repoDeleteError.message.toLowerCase() : ''
          const isMissing = message.includes('404') || message.includes('not found')
          if (!isMissing) {
            throw repoDeleteError
          }
        }
      }

      setLastAutoBackupAt('')

      if (deleted) {
        setCloudBackupStatus('Deleted cloud backup from backup repository.')
      } else {
        setCloudBackupStatus('No cloud backup found to delete.')
      }
    } catch (deleteError) {
      const deleteMessage = explainGitHubError(deleteError, 'Could not delete cloud backup.')
      setCloudBackupStatus(deleteMessage)
      setError(deleteMessage)
    } finally {
      setIsDeletingCloudBackup(false)
    }
  }

  useEffect(() => {
    if (!hasHydratedLibrary || hasAttemptedLoginRestoreRef.current) {
      return
    }

    if (!githubUser || !githubAccessToken || isAuthLoading) {
      return
    }

    hasAttemptedLoginRestoreRef.current = true
    restoreLibraryFromGitHub({ silent: true, fromLogin: true }).catch(() => {
      // Status/error handling is managed inside restoreLibraryFromGitHub.
    })
  }, [hasHydratedLibrary, githubUser, githubAccessToken, isAuthLoading])

  useEffect(() => {
    if (!autoBackupEnabled || !syncMeta.at || !githubUser || !githubAccessToken) {
      return
    }

    if (syncMeta.at === lastAutoBackedSyncAtRef.current) {
      return
    }

    if (!allDocs.length) {
      return
    }

    if (isBackingUpCloud || isRestoringCloud || isDeletingCloudBackup) {
      return
    }

    backupLibraryToGitHub({ silent: true })
      .then((didBackup) => {
        if (didBackup) {
          lastAutoBackedSyncAtRef.current = syncMeta.at
          setLastAutoBackupAt(new Date().toISOString())
        }
      })
      .catch(() => {
        // Error is reflected in cloudBackupStatus for silent mode.
      })
  }, [
    autoBackupEnabled,
    syncMeta.at,
    githubUser,
    githubAccessToken,
    allDocs.length,
    isBackingUpCloud,
    isRestoringCloud,
    isDeletingCloudBackup,
  ])

  if (!githubUser) {
    return (
      <div className="login-gate-shell">
        <section className="login-gate-frame">
          <div className="login-gate-left">
            <div className="login-brand-row">
              <span className="login-brand-mark" aria-hidden="true">
                <svg className="login-brand-mark-svg" viewBox="0 0 24 24" focusable="false">
                  <path d="M4 8.5 12 4l8 4.5-8 4.5L4 8.5Z" />
                  <path d="M4 12.5 12 8l8 4.5-8 4.5-8-4.5Z" opacity="0.75" />
                  <path d="M4 16.5 12 12l8 4.5-8 4.5-8-4.5Z" opacity="0.55" />
                </svg>
              </span>
              <span className="login-brand-title">Docs Hub</span>
            </div>

            <h1 className="login-gate-heading">
              Read smarter.
              <br />
              Sync your docs.
            </h1>

            <p className="login-gate-copy">
              Markdown + GitHub power. Access your Markdown documentation anywhere with persistent cloud sync.
            </p>

            <div className="login-feature-list" role="list" aria-label="Key features">
              <p role="listitem"><span className="login-feature-check">✓</span>Git-based repo sync</p>
              <p role="listitem"><span className="login-feature-check">✓</span>Offline reading and indexed storage</p>
              <p role="listitem"><span className="login-feature-check">✓</span>Secure cloud backup</p>
            </div>
          </div>

          <div className="login-gate-right">
            <section className="login-auth-card">
              <h2 className="login-auth-title">Welcome back</h2>
              <p className="login-auth-subtitle">Sign in to continue to Docs Hub</p>

              {error ? <p className="error-banner">{error}</p> : null}

              <button
                className="button button-primary login-cta"
                onClick={signInWithGitHub}
                disabled={isStartingGitHubLogin || isAuthLoading || !isSupabaseConfigured}
              >
                <span className="login-cta-icon" aria-hidden="true">
                  <svg className="login-cta-icon-mark" viewBox="0 0 24 24" focusable="false">
                    <path d="M12 .5C5.73.5.75 5.48.75 11.75c0 5.02 3.25 9.28 7.76 10.78.57.1.78-.25.78-.56 0-.27-.01-1.18-.02-2.14-3.16.69-3.83-1.34-3.83-1.34-.52-1.31-1.26-1.66-1.26-1.66-1.03-.7.08-.69.08-.69 1.14.08 1.74 1.17 1.74 1.17 1.01 1.73 2.65 1.23 3.29.94.1-.73.4-1.23.72-1.51-2.52-.29-5.17-1.26-5.17-5.62 0-1.24.44-2.25 1.17-3.05-.12-.29-.51-1.46.11-3.05 0 0 .95-.3 3.11 1.16a10.86 10.86 0 0 1 5.67 0c2.16-1.46 3.1-1.16 3.1-1.16.62 1.59.23 2.76.12 3.05.73.8 1.16 1.81 1.16 3.05 0 4.37-2.66 5.33-5.19 5.61.41.35.77 1.03.77 2.08 0 1.5-.01 2.71-.01 3.08 0 .31.2.67.79.56a11.26 11.26 0 0 0 7.75-10.78C23.25 5.48 18.27.5 12 .5Z" />
                  </svg>
                </span>
                {isStartingGitHubLogin || isAuthLoading ? 'Preparing login...' : 'Continue with GitHub'}
              </button>

              <p className="login-auth-note">Secure OAuth. No passwords stored.</p>

              {!isSupabaseConfigured ? (
                <p className="login-auth-warning">
                  Supabase auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
                </p>
              ) : null}
            </section>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className={`app-shell ${isMobileSyncBarVisible ? 'mobile-sync-open' : ''}`}>
      <Suspense fallback={null}>
        <Joyride
          steps={tourSteps}
          run={isTourRunning}
          continuous
          showSkipButton
          showProgress
          disableScrollParentFix
          scrollToFirstStep
          callback={onTourCallback}
          styles={{
            options: {
              zIndex: 10000,
              primaryColor: '#1e87a8',
              textColor: '#1f2a3c',
              width: isMobileViewport ? 300 : 380,
            },
          }}
          locale={{
            back: 'Back',
            close: 'Close',
            last: 'Done',
            next: 'Next',
            skip: 'Skip',
          }}
        />
      </Suspense>

      <aside className={`sidebar ${isSectionsPanelOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">Docs Hub</div>

        <section className="sidebar-nav-block">
          <h2>Navigation</h2>
          <div className="sidebar-nav-list">
            <button
              className={`nav-link ${activeView === 'dashboard' ? 'nav-link-active' : ''}`}
              type="button"
              onClick={() => setActiveView('dashboard')}
            >
              <span className="nav-link-inner">
                <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" />
                  <rect x="14" y="3" width="7" height="11" rx="1.5" />
                  <rect x="3" y="14" width="7" height="7" rx="1.5" />
                  <rect x="14" y="18" width="7" height="3" rx="1.5" />
                </svg>
                <span>Dashboard</span>
              </span>
            </button>
            <button
              className={`nav-link ${activeView === 'git' ? 'nav-link-active' : ''}`}
              type="button"
              onClick={() => setActiveView('git')}
            >
              <span className="nav-link-inner">
                <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3 4 11l8 8 8-8-8-8Z" />
                  <circle cx="9" cy="9" r="1.3" />
                  <circle cx="12" cy="12" r="1.3" />
                  <path d="M9.9 9.9 14 14" />
                </svg>
                <span>Git</span>
              </span>
            </button>
            <button
              className={`nav-link ${activeView === 'settings' ? 'nav-link-active' : ''}`}
              type="button"
              onClick={() => setActiveView('settings')}
            >
              <span className="nav-link-inner">
                <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3.5 7.5h6l2 2h9v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2Z" />
                </svg>
                <span>Local</span>
              </span>
            </button>
            <button
              className={`nav-link ${activeView === 'chat' ? 'nav-link-active' : ''}`}
              type="button"
              onClick={() => setActiveView('chat')}
            >
              <span className="nav-link-inner">
                <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-5l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
                </svg>
                <span>AI Assistant</span>
              </span>
            </button>
          </div>
        </section>

        {activeView === 'dashboard' ? (
          <>
            <div className="sidebar-header">
              <h2>Sections</h2>
              <span>
                {dashboardSearchQuery.trim() ? `${filteredDocsCount} of ${allDocs.length} docs` : `${allDocs.length} docs`}
              </span>
              <button className="mobile-close-sections" onClick={() => setIsSectionsPanelOpen(false)}>
                Close
              </button>
            </div>

            <div className="sidebar-search-row">
              <input
                className="repo-input sidebar-search-input"
                type="text"
                value={dashboardSearchQuery}
                onChange={(event) => setDashboardSearchQuery(event.target.value)}
                placeholder="Search title, path, section, and content"
              />
            </div>

            {library.length ? (
              <nav>
                {repoGroups.map((repoGroup) => (
                  <section key={repoGroup.repo} className="repo-block">
                    <h3>{repoGroup.repo}</h3>
                    {repoGroup.sections.map((section) => {
                      const sectionReadCount = section.docs.reduce((count, doc) => {
                        return isDocRead(doc) ? count + 1 : count
                      }, 0)

                      return (
                      <section key={section.id} className="section-block">
                        <button
                          type="button"
                          className="section-toggle"
                          aria-expanded={
                            expandedSectionIds.has(section.id) || section.docs.some((doc) => doc.id === selectedDocId)
                          }
                          onClick={() => {
                            setExpandedSectionIds((previous) => {
                              const next = new Set(previous)
                              if (next.has(section.id)) {
                                next.delete(section.id)
                              } else {
                                next.add(section.id)
                              }
                              return next
                            })
                          }}
                        >
                          <span className="section-toggle-title">{section.title}</span>
                          <span className="section-toggle-meta">
                            <span className="section-toggle-read">{sectionReadCount}/{section.docs.length} read</span>
                            <span className="section-toggle-count">{section.docs.length}</span>
                          </span>
                        </button>
                        {expandedSectionIds.has(section.id) || section.docs.some((doc) => doc.id === selectedDocId) ? (
                          <ul>
                            {section.docs.map((doc) => (
                              <li key={doc.id}>
                                <button
                                  className={`doc-link ${selectedDocId === doc.id ? 'active' : ''} ${isDocRead(doc) ? 'doc-link-read' : ''}`}
                                  onClick={() => {
                                    setActiveView('dashboard')
                                    setSelectedDocId(doc.id)
                                    setIsSectionsPanelOpen(false)
                                  }}
                                >
                                  <span className="doc-link-content">
                                    <span className="doc-link-title">{doc.title}</span>
                                    {isDocRead(doc) ? (
                                      <span
                                        className="doc-read-badge"
                                        role="button"
                                        tabIndex={0}
                                        aria-label={`Mark ${doc.title} as unread`}
                                        onClick={(event) => {
                                          event.preventDefault()
                                          event.stopPropagation()
                                          markDocUnread(doc)
                                        }}
                                        onKeyDown={(event) => {
                                          if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault()
                                            event.stopPropagation()
                                            markDocUnread(doc)
                                          }
                                        }}
                                      >
                                        Read
                                      </span>
                                    ) : null}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </section>
                      )
                    })}
                  </section>
                ))}
              </nav>
            ) : (
              <p className="placeholder">Upload markdown or PDF notes to generate sections automatically.</p>
            )}

            {library.length && !repoGroups.length ? (
              <p className="placeholder">No docs matched your search. Try a different keyword.</p>
            ) : null}
          </>
        ) : (
          <section className="sidebar-info-card">
            <h3>{activeView === 'git' ? 'Git' : activeView === 'profile' ? 'Profile' : activeView === 'chat' ? 'AI Assistant' : 'Local'}</h3>
            <p>
              {activeView === 'git'
                ? 'Pull from GitHub and sync repositories.'
                : activeView === 'profile'
                  ? 'Manage account security and cloud backup.'
                  : activeView === 'chat'
                    ? 'Ask questions and retrieve grounded context from your docs.'
                  : 'Manage local uploads and library storage.'}
            </p>
          </section>
        )}
      </aside>

      <div className="main-shell">
        <header className="main-topbar">
          <div className="mobile-reader-toolbar">
            {activeView === 'dashboard' ? (
              <button
                className="button mobile-menu-button"
                onClick={() => setIsSectionsPanelOpen(true)}
                aria-label="Open sections menu"
              >
                <span className="hamburger" aria-hidden="true">
                  <span className="hamburger-line" />
                  <span className="hamburger-line" />
                  <span className="hamburger-line" />
                </span>
              </button>
            ) : null}
            <span className="mobile-toolbar-title">
              {activeView === 'dashboard'
                ? selectedDoc
                  ? selectedDoc.title
                  : 'Dashboard'
                : activeView === 'git'
                  ? 'Git'
                  : activeView === 'chat'
                    ? 'AI Assistant'
                  : activeView === 'profile'
                    ? 'Profile'
                    : 'Local'}
            </span>
          </div>

          {activeView === 'dashboard' && selectedDoc ? (
            <div className="reader-top-meta" aria-live="polite">
              <div className="reader-progress-line" role="progressbar" aria-valuenow={readingProgress} aria-valuemin={0} aria-valuemax={100}>
                <span className="reader-progress-fill" style={{ width: `${readingProgress}%` }} />
              </div>
              <p className="reader-meta-copy">
                <span>{selectedDocReadStats.readTimeLabel}</span>
                <span>{readingProgress}% read</span>
              </p>
            </div>
          ) : null}

          <button
            className={`topbar-profile-button ${activeView === 'profile' ? 'topbar-profile-button-active' : ''}`}
            type="button"
            onClick={() => setActiveView('profile')}
            aria-label="Open profile"
            title={githubLogin ? `Open @${githubLogin} profile` : 'Open profile'}
          >
            {githubUser?.user_metadata?.avatar_url ? (
              <img
                className="topbar-profile-avatar"
                src={githubUser.user_metadata.avatar_url}
                alt={githubLogin ? `${githubLogin} profile` : 'Profile'}
              />
            ) : (
              <span className="topbar-profile-fallback" aria-hidden="true">
                {String(githubLogin || githubUser?.email || 'P').charAt(0).toUpperCase()}
              </span>
            )}
          </button>
        </header>

        {error ? <p className="error-banner">{error}</p> : null}
        {storageWarning ? <p className="storage-banner">{storageWarning}</p> : null}

        <main className={`document-panel ${activeView === 'chat' ? 'document-panel-chat' : ''}`} ref={documentPanelRef}>
          {activeView === 'dashboard' ? (
            <>
              {selectedDoc ? (
                <article className="reader-card">
                  <header className="document-header">
                    <p>{selectedDoc.sourceRepo || getRepoFromSource(selectedDoc.source)}</p>
                    <h2>{selectedDoc.title}</h2>
                    <span className="document-read-meta">{selectedDocReadStats.readTimeLabel}</span>
                  </header>

                  <div className="markdown-body">
                    {isPdfDoc(selectedDoc) ? (
                      isPdfPageRendering ? (
                        <p className="placeholder">Rendering PDF pages...</p>
                      ) : pdfRenderError ? (
                        <p className="placeholder">Could not render PDF preview: {pdfRenderError}</p>
                      ) : selectedPdfPages.length ? (
                        <div className="pdf-pages">
                          {selectedPdfPages.map((pageImage, index) => (
                            <img key={`${selectedDoc.id}-page-${index + 1}`} className="pdf-page-image" src={pageImage} alt={`Page ${index + 1}`} />
                          ))}
                        </div>
                      ) : selectedDoc.pdfBase64 ? (
                        <p className="placeholder">Loading PDF preview...</p>
                      ) : (
                        <p className="placeholder">PDF binary is not available in this record. Re-import this PDF to open it.</p>
                      )
                    ) : (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {selectedDoc.content}
                      </ReactMarkdown>
                    )}
                  </div>
                </article>
              ) : (
                <div className="empty-state">
                  <h2>Your docs hub is ready</h2>
                  <p>
                    Start by uploading markdown or PDF files. Folder uploads preserve structure, so each top-level folder
                    becomes a section.
                  </p>
                </div>
              )}
            </>
          ) : null}

          {activeView === 'git' ? (
            <>
              <section className="sync-card">
                <div className="sync-card-header">
                  <div>
                    <p className="eyebrow">Git</p>
                    <p className="sync-description">Pull from public repos and sync your docs.</p>
                  </div>
                </div>

                <div className="git-mode-tabs" role="tablist" aria-label="Git sync mode">
                  <button
                    type="button"
                    className={`git-mode-tab ${gitSyncMode === 'repos' ? 'git-mode-tab-active' : ''}`}
                    onClick={() => setGitSyncMode('repos')}
                    role="tab"
                    aria-selected={gitSyncMode === 'repos'}
                  >
                    My Repos
                  </button>
                  <button
                    type="button"
                    className={`git-mode-tab ${gitSyncMode === 'url' ? 'git-mode-tab-active' : ''}`}
                    onClick={() => setGitSyncMode('url')}
                    role="tab"
                    aria-selected={gitSyncMode === 'url'}
                  >
                    URL Import
                  </button>
                </div>

                {gitSyncMode === 'repos' && githubUser ? (
                  <div className="repo-picker-panel">
                    <div className="repo-search-row">
                      <input
                        className="repo-input repo-search-input"
                        type="text"
                        placeholder="Search repositories"
                        value={repoSearchQuery}
                        onChange={(event) => setRepoSearchQuery(event.target.value)}
                        disabled={isLoadingMyRepos || isSyncingSelectedRepos || !myRepos.length}
                      />
                      <button
                        className="button button-primary repo-sync-inline-btn"
                        onClick={syncSelectedRepos}
                        disabled={!selectedRepoNames.length || isSyncingSelectedRepos || isLoadingMyRepos}
                      >
                        {isSyncingSelectedRepos ? 'Syncing...' : 'Sync'}
                      </button>
                    </div>

                    <p className="repo-hint">
                      {isLoadingMyRepos
                        ? 'Loading your repositories...'
                        : `${selectedRepoNames.length} selected from ${myRepos.length} repos.`}
                    </p>

                    {myRepos.length ? (
                      <div className="repo-list" role="listbox" aria-label="Repository selection">
                        {filteredMyRepos.map((repo) => {
                          const checked = selectedRepoNames.includes(repo.fullName)
                          return (
                            <label key={repo.id} className="repo-item">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleRepoSelection(repo.fullName)}
                                disabled={isSyncingSelectedRepos}
                              />
                              <span className="repo-main">{repo.fullName}</span>
                              <span className="repo-meta">{repo.private ? 'Private' : 'Public'}</span>
                            </label>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="repo-hint">Your repositories will load automatically after login.</p>
                    )}

                    {myRepos.length && !filteredMyRepos.length ? (
                      <p className="repo-hint">No repositories match your search.</p>
                    ) : null}
                  </div>
                ) : null}

                {gitSyncMode === 'repos' && !githubUser ? (
                  <p className="repo-hint">Login with GitHub to sync from your repositories.</p>
                ) : null}

                {gitSyncMode === 'url' ? (
                  <div className="repo-picker-panel">
                    <div className="repo-pull-row">
                      <input
                        className="repo-input"
                        type="text"
                        placeholder="Paste GitHub URL or owner/repo"
                        value={repoInput}
                        onChange={(event) => setRepoInput(event.target.value)}
                        disabled={isPullingRepo || isForkSyncing}
                      />
                      <button className="button button-primary" onClick={pullGitHubRepo} disabled={isPullingRepo}>
                        {isPullingRepo ? 'Pulling...' : 'Pull from GitHub'}
                      </button>
                      <button
                        className="button"
                        onClick={forkAndSyncRepo}
                        disabled={isForkSyncing || isStartingGitHubLogin || !repoInput.trim() || !githubUser}
                      >
                        {isForkSyncing ? 'Forking...' : 'Fork + Sync to My Account'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {repoStatus ? <p className="repo-status">{repoStatus}</p> : null}

                <div className="sync-status-panel" role="status" aria-live="polite">
                  <p className="sync-status-title">Sync status</p>
                  <p className="sync-status-line">Latest event: {repoStatus || 'Idle'}</p>
                  <p className="sync-status-line">Last successful sync: {formatDateTime(syncMeta.at)}</p>
                  {syncMeta.summary ? <p className="sync-status-line">Summary: {syncMeta.summary}</p> : null}
                </div>
              </section>
            </>
          ) : null}

          {activeView === 'chat' ? (
            <>
              <section className="sync-card chat-screen">
                <div className="sync-card-header">
                  <div>
                    <h2 className="eyebrow">AI Assistant</h2>
                    <p className="sync-description">Query your indexed knowledge base with section or library scope.</p>
                    <div className="rag-status-strip" role="status" aria-live="polite">
                      <span className={`rag-status-pill rag-status-pill-${ragIndexTone}`} title={ragIndexStatus}>
                        Index
                      </span>
                      <span className={`rag-status-pill rag-status-pill-${ragEmbeddingTone}`} title={ragEmbeddingStatus}>
                        Embeddings
                      </span>
                    </div>
                  </div>
                </div>

                <div className="sync-status-panel chat-shell" role="region" aria-label="Chat panel">
                  <div className="chat-toolbar-row">
                    <div className="chat-scope-row" role="tablist" aria-label="Chat retrieval scope">
                      <button
                        className="button"
                        onClick={() => setChatScope('section')}
                        disabled={isChatResponding || chatScope === 'section'}
                      >
                        Current section
                      </button>
                      <button
                        className="button"
                        onClick={() => setChatScope('all')}
                        disabled={isChatResponding || chatScope === 'all'}
                      >
                        Library
                      </button>
                    </div>

                    <button className="button chat-clear-btn" onClick={clearChatConversation} disabled={isChatResponding}>
                      <svg className="chat-clear-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v8h-2V9zm4 0h2v8h-2V9zM7 9h2v8H7V9zm1 12h8a2 2 0 0 0 2-2V9H6v10a2 2 0 0 0 2 2z" />
                      </svg>
                      Clear chat
                    </button>
                  </div>

                  <div className="chat-history" ref={chatHistoryRef} role="log" aria-live="polite" aria-label="Chat messages">
                    <div className="chat-thread">
                      {chatMessages.map((message) => (
                        <div key={message.id} className={`chat-message-row ${message.role === 'user' ? 'chat-message-user' : 'chat-message-assistant'}`}>
                          <div className="chat-message-card">
                            <span className="chat-message-role">{message.role === 'user' ? 'You' : 'Assistant'}</span>
                            <div className="chat-message-content">
                              {message.role === 'assistant' ? (
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                              ) : (
                                <p>{message.content}</p>
                              )}
                            </div>

                            {message.role === 'assistant' && Array.isArray(message.citations) && message.citations.length ? (
                              <div className="chat-citations">
                                <strong>Citations:</strong>
                                <ul>
                                  {message.citations.slice(0, 4).map((citation) => (
                                    <li key={`${message.id}-${citation.chunkId}`}>
                                      <button
                                        type="button"
                                        className="chat-citation-link"
                                        onClick={() => {
                                          if (!citation.docId) {
                                            return
                                          }

                                          setActiveView('dashboard')
                                          setSelectedDocId(citation.docId)
                                        }}
                                      >
                                        {citation.title} ({citation.section}) - score {Number(citation.score || 0).toFixed(3)}
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ))}

                      {isChatResponding ? (
                        <div className="chat-message-row chat-message-assistant">
                          <div className="chat-message-card chat-message-typing" aria-label="Assistant is typing">
                            <span className="chat-message-role">Assistant</span>
                            <div className="chat-typing-dots" aria-hidden="true">
                              <span />
                              <span />
                              <span />
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="chat-input-row">
                    <input
                      className="repo-input chat-input"
                      type="text"
                      placeholder="Ask a question about your docs"
                      value={chatInput}
                      onChange={(event) => setChatInput(event.target.value)}
                      disabled={isChatResponding}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault()
                          runChatWithRag()
                        }
                      }}
                    />
                    <button className="button button-primary" onClick={runChatWithRag} disabled={isChatResponding || !chatInput.trim()}>
                      {isChatResponding ? 'Thinking...' : 'Send'}
                    </button>
                  </div>
                </div>
              </section>
            </>
          ) : null}

          {activeView === 'settings' ? (
            <>
              <section className="settings-card">
                <div className="settings-card-header">
                  <div>
                    <h1 className="eyebrow">Local</h1>
                    <p className="settings-description">Manage your local library, import, and export tools.</p>
                  </div>
                </div>

                <div className="settings-divider" />
                <div className="settings-grid">
                  <section className="settings-item">
                    <h3>Uploads</h3>
                    <p>Add markdown or PDF files and folders from your device.</p>
                    <div className="settings-actions">
                      <label className="button button-primary" htmlFor="upload-md-settings">
                        Upload docs
                      </label>
                      <input
                        id="upload-md-settings"
                        type="file"
                        accept=".md,.mdx,.pdf,text/markdown,application/pdf"
                        multiple
                        onChange={onUploadFiles}
                      />
                      <label className="button" htmlFor="upload-folder-settings">
                        Upload folder
                      </label>
                      <input
                        id="upload-folder-settings"
                        type="file"
                        accept=".md,.mdx,.pdf,text/markdown,application/pdf"
                        multiple
                        webkitdirectory=""
                        directory=""
                        onChange={onUploadFiles}
                      />
                    </div>
                  </section>
                </div>

                <div className="settings-divider" />
                <h2 className="settings-title">Library Management</h2>
                <p className="settings-subtitle">Import, export, and manage your document library.</p>

                <div className="settings-grid">
                  <section className="settings-item">
                    <h3>Library</h3>
                    <p>{allDocs.length} docs currently in local storage.</p>
                    <div className="settings-actions">
                      <label className="button" htmlFor="import-json-settings">
                        Import library
                      </label>
                      <input
                        id="import-json-settings"
                        type="file"
                        accept="application/json"
                        onChange={importLibrary}
                      />
                      <button className="button" onClick={exportLibrary} disabled={!library.length}>
                        Export library
                      </button>
                      <button className="button button-danger" onClick={clearLibrary} disabled={!library.length}>
                        Clear library
                      </button>
                    </div>
                  </section>
                </div>
              </section>
            </>
          ) : null}

          {activeView === 'profile' ? (
            <>
              <section className="settings-card">
                <div className="settings-card-header">
                  <div>
                    <p className="eyebrow">Account</p>
                    <h1>Profile</h1>
                    <p className="settings-description">Manage session, cloud backup, and recovery options.</p>
                  </div>
                </div>

                <div className="settings-grid">
                  <section className="settings-item">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                      {githubUser?.user_metadata?.avatar_url ? (
                        <img
                          src={githubUser.user_metadata.avatar_url}
                          alt={githubLogin}
                          style={{
                            width: '48px',
                            height: '48px',
                            borderRadius: '50%',
                            border: '2px solid #d0d6e8'
                          }}
                        />
                      ) : null}
                      <div>
                        <h3>Signed in as</h3>
                        <p>{githubLogin ? `@${githubLogin}` : 'GitHub account connected'}</p>
                      </div>
                    </div>
                    <div className="settings-actions">
                      <button className="button button-danger" onClick={signOutGitHub}>
                        Logout
                      </button>
                      <button className="button" onClick={startOnboardingTour}>
                        Replay Tour
                      </button>
                    </div>
                  </section>
                </div>

                <div className="settings-divider" />
                <h2 className="settings-title">Cloud Backup (GitHub)</h2>
                <p className="settings-subtitle">Save your library off-device so it can be restored anytime.</p>

                <div className="settings-grid">
                  <section className="settings-item">
                    <label className="backup-toggle-row">
                      <input
                        type="checkbox"
                        checked={autoBackupEnabled}
                        onChange={(event) => setAutoBackupEnabled(event.target.checked)}
                      />
                      <span>Auto-backup after successful sync</span>
                    </label>

                    <div className="settings-actions">
                      <button
                        className="button button-primary"
                        onClick={backupLibraryToGitHub}
                        disabled={!library.length || isBackingUpCloud || isRestoringCloud || isDeletingCloudBackup}
                      >
                        {isBackingUpCloud ? 'Saving...' : 'Backup'}
                      </button>
                      <button
                        className="button"
                        onClick={restoreLibraryFromGitHub}
                        disabled={isBackingUpCloud || isRestoringCloud || isDeletingCloudBackup}
                      >
                        {isRestoringCloud ? 'Restoring...' : 'Restore'}
                      </button>
                      <button
                        className="button button-danger"
                        onClick={deleteCloudBackupFromGitHub}
                        disabled={isBackingUpCloud || isRestoringCloud || isDeletingCloudBackup}
                      >
                        {isDeletingCloudBackup ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>

                    {lastAutoBackupAt ? <p className="repo-hint">Last auto backup: {formatDateTime(lastAutoBackupAt)}</p> : null}
                    {cloudBackupStatus ? <p className="repo-hint">{cloudBackupStatus}</p> : null}
                  </section>
                </div>
              </section>
            </>
          ) : null}

        </main>
      </div>

      {isMobileSyncBarVisible ? (
        <div className="mobile-sync-bar" role="region" aria-label="Mobile sync actions">
          <span className="mobile-sync-meta">{selectedRepoNames.length} selected</span>
          <button
            className="button button-primary"
            onClick={syncSelectedRepos}
            disabled={!selectedRepoNames.length || isSyncingSelectedRepos || isLoadingMyRepos}
          >
            {isSyncingSelectedRepos ? 'Syncing...' : 'Sync'}
          </button>
        </div>
      ) : null}

      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        <button
          className={`mobile-bottom-link ${activeView === 'dashboard' ? 'mobile-bottom-link-active' : ''}`}
          type="button"
          onClick={() => setActiveView('dashboard')}
        >
          Dashboard
        </button>
        <button
          className={`mobile-bottom-link ${activeView === 'git' ? 'mobile-bottom-link-active' : ''}`}
          type="button"
          onClick={() => setActiveView('git')}
        >
          Git
        </button>
        <button
          className={`mobile-bottom-link ${activeView === 'settings' ? 'mobile-bottom-link-active' : ''}`}
          type="button"
          onClick={() => setActiveView('settings')}
        >
          Local
        </button>
        <button
          className={`mobile-bottom-link ${activeView === 'chat' ? 'mobile-bottom-link-active' : ''}`}
          type="button"
          onClick={() => setActiveView('chat')}
        >
          Chat
        </button>
      </nav>

      {isSectionsPanelOpen ? <button className="sidebar-scrim" onClick={() => setIsSectionsPanelOpen(false)} /> : null}
    </div>
  )
}

export default App
