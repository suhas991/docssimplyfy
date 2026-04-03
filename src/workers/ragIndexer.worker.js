const CHUNKING_VERSION = 'v1'
const APPROX_MAX_TOKENS = 520
const APPROX_CHARS_PER_TOKEN = 4
const MAX_CHARS_PER_CHUNK = APPROX_MAX_TOKENS * APPROX_CHARS_PER_TOKEN

function isIndexableDoc(doc) {
  return Boolean(String(doc?.content || '').trim())
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\t/g, ' ').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

function splitByHeadings(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let currentHeading = ''
  let currentLines = []

  const pushBlock = () => {
    const content = currentLines.join('\n').trim()
    if (!content) {
      currentLines = []
      return
    }

    blocks.push({
      heading: currentHeading,
      content,
    })
    currentLines = []
  }

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line.trim())) {
      pushBlock()
      currentHeading = line.replace(/^#{1,3}\s+/, '').trim()
      continue
    }

    currentLines.push(line)
  }

  pushBlock()

  if (!blocks.length) {
    return [{ heading: '', content: String(markdown || '').trim() }]
  }

  return blocks
}

function splitLongText(text, maxChars) {
  const normalized = String(text || '').trim()
  if (!normalized) {
    return []
  }

  if (normalized.length <= maxChars) {
    return [normalized]
  }

  const parts = []
  let start = 0

  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length)

    if (end < normalized.length) {
      const nextBreak = normalized.lastIndexOf(' ', end)
      if (nextBreak > start + Math.floor(maxChars * 0.6)) {
        end = nextBreak
      }
    }

    parts.push(normalized.slice(start, end).trim())
    start = end
  }

  return parts.filter(Boolean)
}

async function sha256Hex(value) {
  const input = String(value || '')

  // Mobile browsers on non-secure origins (e.g. http://<LAN-IP>:5173) may not expose crypto.subtle.
  if (typeof crypto === 'undefined' || !crypto.subtle || typeof crypto.subtle.digest !== 'function') {
    let h1 = 0x811c9dc5
    let h2 = 0x01000193

    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index)
      h1 ^= code
      h1 = Math.imul(h1, 0x01000193)
      h2 ^= code + ((index % 13) * 17)
      h2 = Math.imul(h2, 0x01000193)
    }

    const hex1 = (h1 >>> 0).toString(16).padStart(8, '0')
    const hex2 = (h2 >>> 0).toString(16).padStart(8, '0')
    return `${hex1}${hex2}${hex1}${hex2}`
  }

  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return hex
}

async function createDocChunks(doc) {
  const text = normalizeWhitespace(doc?.content || '')
  if (!text) {
    return []
  }

  const sections = splitByHeadings(text)
  const chunks = []
  let index = 0

  for (const section of sections) {
    const headingPrefix = section.heading ? `${section.heading}\n\n` : ''
    const splitParts = splitLongText(section.content, MAX_CHARS_PER_CHUNK)

    for (const part of splitParts) {
      const chunkText = normalizeWhitespace(`${headingPrefix}${part}`)
      if (!chunkText) {
        continue
      }

      const hash = await sha256Hex(`${doc.id}\n${index}\n${chunkText}`)
      chunks.push({
        chunkId: `${doc.id}:${index}:${hash.slice(0, 12)}`,
        docId: String(doc.id || ''),
        title: String(doc.title || ''),
        section: String(doc.section || 'General'),
        source: String(doc.source || ''),
        sourceRepo: String(doc.sourceRepo || 'Local Uploads'),
        chunkIndex: index,
        content: chunkText,
        hash,
        chunkingVersion: CHUNKING_VERSION,
      })
      index += 1
    }
  }

  return chunks
}

self.onmessage = async (event) => {
  const payload = event?.data || {}

  if (payload.type !== 'index-library') {
    return
  }

  const requestId = payload.requestId || ''
  const docs = Array.isArray(payload.docs) ? payload.docs : []

  try {
    const indexableDocs = docs.filter((doc) => isIndexableDoc(doc))
    const chunks = []

    for (let i = 0; i < indexableDocs.length; i += 1) {
      const doc = indexableDocs[i]
      const docChunks = await createDocChunks(doc)
      chunks.push(...docChunks)

      self.postMessage({
        type: 'index-progress',
        requestId,
        processedDocs: i + 1,
        totalDocs: indexableDocs.length,
        chunkCount: chunks.length,
      })
    }

    self.postMessage({
      type: 'index-complete',
      requestId,
      chunks,
      meta: {
        chunkingVersion: CHUNKING_VERSION,
        indexedDocCount: indexableDocs.length,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    self.postMessage({
      type: 'index-error',
      requestId,
      error: message,
    })
  }
}
