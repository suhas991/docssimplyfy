import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import './App.css'

const STORAGE_KEY = 'docs-site.library.v1'
const GH_PROVIDER_TOKEN_STORAGE_KEY = 'docs-site.github-provider-token.v1'
const VIEW_STORAGE_KEY = 'docs-site.active-view.v1'
const POST_AUTH_VIEW_KEY = 'docs-site.post-auth-view.v1'
const SYNC_META_STORAGE_KEY = 'docs-site.sync-meta.v1'
const BACKUP_REPO_NAME = 'docs-hub-backup'
const BACKUP_REPO_FILE = 'docs-library-backup.json'
const LIBRARY_DB_NAME = 'docs-site-db'
const LIBRARY_DB_VERSION = 1
const LIBRARY_STORE_NAME = 'app-state'
const LIBRARY_STORE_KEY = 'library'

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

function normalizeView(value) {
  if (value === 'sync') {
    return 'git'
  }

  if (value === 'dashboard' || value === 'git' || value === 'settings' || value === 'profile') {
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
  return value.replace(/\.(md|mdx)$/i, '')
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

function getPathVariants(path) {
  const normalized = normalizeDocPath(path)
  if (!normalized) {
    return []
  }

  const basename = normalized.split('/').pop() || normalized
  const withoutExt = normalized.replace(/\.(md|mdx)$/i, '')
  const basenameWithoutExt = basename.replace(/\.(md|mdx)$/i, '')

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

  const markdownEntries = (treeData.tree || [])
    .filter((item) => item.type === 'blob')
    .filter((item) => /\.(md|mdx)$/i.test(item.path))

  if (!markdownEntries.length) {
    throw new Error('No markdown files found in this repository.')
  }

  const maxFiles = 120
  const limitedEntries = markdownEntries.slice(0, maxFiles)

  const docs = await Promise.all(
    limitedEntries.map(async (entry) => {
      const encodedPath = encodeRepoPath(entry.path)
      const fileData = await githubRequest(
        `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(defaultBranch)}`,
        token,
      )

      if (!fileData?.content) {
        throw new Error(`Failed to download ${entry.path}`)
      }

      const content = decodeGitHubContent(fileData.content)
      return {
        id: `${toSlug(entry.path)}-${crypto.randomUUID()}`,
        title: getTitleFromPath(entry.path),
        section: getSectionFromPath(entry.path),
        sourceRepo: `${owner}/${repo}`,
        source: `github:${owner}/${repo}/${entry.path}`,
        content,
        updatedAt: new Date().toISOString(),
      }
    }),
  )

  return {
    docs,
    markdownCount: markdownEntries.length,
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

function App() {
  const [activeView, setActiveView] = useState(() => {
    return normalizeView(localStorage.getItem(VIEW_STORAGE_KEY))
  })
  const [library, setLibrary] = useState([])
  const [expandedSectionIds, setExpandedSectionIds] = useState(() => new Set())
  const [selectedDocId, setSelectedDocId] = useState('')
  const [dashboardSearchQuery, setDashboardSearchQuery] = useState('')
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
  const lastAutoBackedSyncAtRef = useRef(syncMeta.at || '')
  const hasAttemptedLoginRestoreRef = useRef(false)

  const isMobileSyncBarVisible = activeView === 'git' && gitSyncMode === 'repos' && Boolean(githubUser)

  const updateSyncMeta = (summary) => {
    setSyncMeta({
      summary,
      at: new Date().toISOString(),
    })
  }

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
          writeLibraryToIndexedDb(parsed).catch(() => {
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

    const persistLibrary = async () => {
      try {
        await writeLibraryToIndexedDb(library)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(library))
        setStorageWarning('')
      } catch {
        setStorageWarning('Storage is full. Export your library or clear unused docs to avoid data loss.')
      }
    }

    persistLibrary()
  }, [library, hasHydratedLibrary])

  useEffect(() => {
    localStorage.setItem(SYNC_META_STORAGE_KEY, JSON.stringify(syncMeta))
  }, [syncMeta])

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

  const allDocs = useMemo(() => {
    return library.flatMap((section) => section.docs)
  }, [library])

  const filteredLibrary = useMemo(() => {
    const query = dashboardSearchQuery.trim().toLowerCase()
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
  }, [library, dashboardSearchQuery])

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
    }
  }, [docsByRepoAndPath, selectedDoc, setActiveView, setError, setSelectedDocId])

  const onUploadFiles = async (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''

    const markdownFiles = files.filter((file) => /\.(md|mdx)$/i.test(file.name))

    if (!markdownFiles.length) {
      setError('Please upload markdown files with .md or .mdx extensions.')
      return
    }

    setError('')

    const docs = await Promise.all(
      markdownFiles.map(async (file) => {
        const content = await file.text()
        return {
          id: `${toSlug(file.name)}-${crypto.randomUUID()}`,
          title: getTitleFromFile(file),
          section: getSectionFromFile(file),
          sourceRepo: 'Local Uploads',
          source: file.webkitRelativePath || file.name,
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(librarySnapshot))
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

    if (!fileData?.content) {
      throw new Error('Backup file content is empty.')
    }

    return decodeGitHubContent(fileData.content)
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
              className={`nav-link ${activeView === 'profile' ? 'nav-link-active' : ''}`}
              type="button"
              onClick={() => setActiveView('profile')}
            >
              <span className="nav-link-inner">
                <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="8" r="3.5" />
                  <path d="M5 20a7 7 0 0 1 14 0" />
                </svg>
                <span>Profile</span>
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
                    {repoGroup.sections.map((section) => (
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
                            <span className="section-toggle-count">{section.docs.length}</span>
                          </span>
                        </button>
                        {expandedSectionIds.has(section.id) || section.docs.some((doc) => doc.id === selectedDocId) ? (
                          <ul>
                            {section.docs.map((doc) => (
                              <li key={doc.id}>
                                <button
                                  className={`doc-link ${selectedDocId === doc.id ? 'active' : ''}`}
                                  onClick={() => {
                                    setActiveView('dashboard')
                                    setSelectedDocId(doc.id)
                                    setIsSectionsPanelOpen(false)
                                  }}
                                >
                                  {doc.title}
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </section>
                    ))}
                  </section>
                ))}
              </nav>
            ) : (
              <p className="placeholder">Upload your markdown notes to generate sections automatically.</p>
            )}

            {library.length && !repoGroups.length ? (
              <p className="placeholder">No docs matched your search. Try a different keyword.</p>
            ) : null}
          </>
        ) : (
          <section className="sidebar-info-card">
            <h3>{activeView === 'git' ? 'Git' : activeView === 'profile' ? 'Profile' : 'Local'}</h3>
            <p>
              {activeView === 'git'
                ? 'Pull from GitHub and sync repositories.'
                : activeView === 'profile'
                  ? 'Manage account security and cloud backup.'
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
                  : activeView === 'profile'
                    ? 'Profile'
                    : 'Local'}
            </span>
          </div>
        </header>

        {error ? <p className="error-banner">{error}</p> : null}
        {storageWarning ? <p className="storage-banner">{storageWarning}</p> : null}

        <main className="document-panel">
          {activeView === 'dashboard' ? (
            <>
              {selectedDoc ? (
                <article className="reader-card">
                  <header className="document-header">
                    <p>{selectedDoc.sourceRepo || getRepoFromSource(selectedDoc.source)}</p>
                    <h2>{selectedDoc.title}</h2>
                  </header>

                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {selectedDoc.content}
                    </ReactMarkdown>
                  </div>
                </article>
              ) : (
                <div className="empty-state">
                  <h2>Your docs hub is ready</h2>
                  <p>
                    Start by uploading markdown files. Folder uploads preserve structure, so each top-level folder
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
                    <h1>Manage Git Docs</h1>
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

          {activeView === 'settings' ? (
            <>
              <section className="settings-card">
                <div className="settings-card-header">
                  <div>
                    <p className="eyebrow">Configuration</p>
                    <h1>Local</h1>
                    <p className="settings-description">Manage your local library, import, and export tools.</p>
                  </div>
                </div>

                <div className="settings-divider" />
                <div className="settings-grid">
                  <section className="settings-item">
                    <h3>Uploads</h3>
                    <p>Add markdown files and folders from your device.</p>
                    <div className="settings-actions">
                      <label className="button button-primary" htmlFor="upload-md-settings">
                        Upload .md files
                      </label>
                      <input
                        id="upload-md-settings"
                        type="file"
                        accept=".md,.mdx,text/markdown"
                        multiple
                        onChange={onUploadFiles}
                      />
                      <label className="button" htmlFor="upload-folder-settings">
                        Upload folder
                      </label>
                      <input
                        id="upload-folder-settings"
                        type="file"
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
          className={`mobile-bottom-link ${activeView === 'profile' ? 'mobile-bottom-link-active' : ''}`}
          type="button"
          onClick={() => setActiveView('profile')}
        >
          Profile
        </button>
      </nav>

      {isSectionsPanelOpen ? <button className="sidebar-scrim" onClick={() => setIsSectionsPanelOpen(false)} /> : null}
    </div>
  )
}

export default App
