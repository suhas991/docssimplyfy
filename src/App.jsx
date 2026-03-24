import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import './App.css'

const STORAGE_KEY = 'docs-site.library.v1'
const GH_PROVIDER_TOKEN_STORAGE_KEY = 'docs-site.github-provider-token.v1'
const VIEW_STORAGE_KEY = 'docs-site.active-view.v1'
const POST_AUTH_VIEW_KEY = 'docs-site.post-auth-view.v1'

function normalizeView(value) {
  if (value === 'sync') {
    return 'git'
  }

  if (value === 'dashboard' || value === 'git' || value === 'settings' || value === 'help') {
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
        const apiError = `GitHub API error: ${response.status} ${response.statusText}. ${errorText}`
        if (attempt === 1 || !import.meta.env.DEV) {
          throw new Error(apiError)
        }
        lastError = apiError
        continue
      }

      return response.json()
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
  const [isSectionsPanelOpen, setIsSectionsPanelOpen] = useState(false)
  const [error, setError] = useState('')
  const [repoInput, setRepoInput] = useState('')
  const [isPullingRepo, setIsPullingRepo] = useState(false)
  const [repoStatus, setRepoStatus] = useState('')
  const [githubUser, setGithubUser] = useState(null)
  const [githubLogin, setGithubLogin] = useState('')
  const [githubAccessToken, setGithubAccessToken] = useState('')
  const [myRepos, setMyRepos] = useState([])
  const [selectedRepoNames, setSelectedRepoNames] = useState([])
  const [isLoadingMyRepos, setIsLoadingMyRepos] = useState(false)
  const [isSyncingSelectedRepos, setIsSyncingSelectedRepos] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(true)
  const [isStartingGitHubLogin, setIsStartingGitHubLogin] = useState(false)
  const [isForkSyncing, setIsForkSyncing] = useState(false)

  useEffect(() => {
    try {
      const cached = localStorage.getItem(STORAGE_KEY)
      if (!cached) {
        return
      }
      const parsed = JSON.parse(cached)
      if (Array.isArray(parsed)) {
        setLibrary(parsed)
      }
    } catch {
      setError('Could not read saved library. You can re-upload your files.')
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(library))
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

  const repoGroups = useMemo(() => {
    const groups = new Map()

    for (const section of library) {
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
  }, [library])

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

    const markdownFiles = files.filter((file) => file.name.toLowerCase().endsWith('.md'))

    if (!markdownFiles.length) {
      setError('Please upload markdown files with the .md extension.')
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

    await supabase.auth.signOut()
    setGithubUser(null)
    setGithubLogin('')
    setGithubAccessToken('')
    setMyRepos([])
    setSelectedRepoNames([])
    sessionStorage.removeItem(GH_PROVIDER_TOKEN_STORAGE_KEY)
    setRepoStatus('Disconnected GitHub account.')
  }

  const loadMyRepos = async () => {
    if (!githubAccessToken) {
      setError('Login with GitHub first.')
      return
    }

    setError('')
    setRepoStatus('Loading your repositories...')
    setIsLoadingMyRepos(true)

    try {
      const repos = await fetchUserRepos(githubAccessToken)
      setMyRepos(repos)
      setSelectedRepoNames([])
      setRepoStatus(`Loaded ${repos.length} repositories. Select the ones you want to sync.`)
    } catch (reposError) {
      setRepoStatus('')
      setError(explainGitHubError(reposError, 'Could not load repositories from your account.'))
    } finally {
      setIsLoadingMyRepos(false)
    }
  }

  const toggleRepoSelection = (fullName) => {
    setSelectedRepoNames((previous) => {
      if (previous.includes(fullName)) {
        return previous.filter((value) => value !== fullName)
      }
      return [...previous, fullName]
    })
  }

  const selectAllRepos = () => {
    setSelectedRepoNames(myRepos.map((repo) => repo.fullName))
  }

  const clearRepoSelection = () => {
    setSelectedRepoNames([])
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

  return (
    <div className="app-shell">
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
              Dashboard
            </button>
            <button
              className={`nav-link ${activeView === 'git' ? 'nav-link-active' : ''}`}
              type="button"
              onClick={() => setActiveView('git')}
            >
              Git
            </button>
            <button
              className={`nav-link ${activeView === 'settings' ? 'nav-link-active' : ''}`}
              type="button"
              onClick={() => setActiveView('settings')}
            >
              Settings
            </button>
            <button
              className={`nav-link ${activeView === 'help' ? 'nav-link-active' : ''}`}
              type="button"
              onClick={() => setActiveView('help')}
            >
              Help
            </button>
          </div>
        </section>

        {activeView === 'dashboard' ? (
          <>
            <div className="sidebar-header">
              <h2>Sections</h2>
              <span>{allDocs.length} docs</span>
              <button className="mobile-close-sections" onClick={() => setIsSectionsPanelOpen(false)}>
                Close
              </button>
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
          </>
        ) : (
          <section className="sidebar-info-card">
            <h3>{activeView === 'git' ? 'Git' : activeView === 'settings' ? 'Settings' : 'Help'}</h3>
            <p>
              {activeView === 'git'
                ? 'Pull from GitHub and sync repositories.'
                : activeView === 'settings'
                  ? 'Configure storage and file import settings.'
                  : 'See setup steps and usage guidance to onboard quickly.'}
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
                  : activeView === 'settings'
                  ? 'Settings'
                : 'Help'}
            </span>
          </div>
        </header>

        {error ? <p className="error-banner">{error}</p> : null}

        <main className="document-panel">
          {activeView === 'dashboard' ? (
            <>
              {selectedDoc ? (
                <article className="reader-card">
                  <header className="document-header">
                    <p>{selectedDoc.sourceRepo || getRepoFromSource(selectedDoc.source)}</p>
                    <h2>{selectedDoc.title}</h2>
                    <span>{selectedDoc.source}</span>
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

                  <div className="github-auth-row">
                    {githubUser ? (
                      <button className="button" onClick={signOutGitHub}>
                        Disconnect ({githubLogin || 'GitHub'})
                      </button>
                    ) : (
                      <button
                        className="button"
                        onClick={signInWithGitHub}
                        disabled={isStartingGitHubLogin || isAuthLoading || !isSupabaseConfigured}
                      >
                        {isStartingGitHubLogin ? 'Redirecting...' : 'Login with GitHub'}
                      </button>
                    )}
                    <span className="auth-note">
                      {isSupabaseConfigured
                        ? githubUser
                          ? 'GitHub login connected through Supabase.'
                          : 'Sign in once, then use repository sync controls.'
                        : 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable login.'}
                    </span>
                  </div>
                </div>

                {githubUser ? (
                  <div className="repo-picker-panel">
                    <div className="repo-picker-actions">
                      <button className="button" onClick={loadMyRepos} disabled={isLoadingMyRepos || isSyncingSelectedRepos}>
                        {isLoadingMyRepos ? 'Loading repos...' : 'Load My Repos'}
                      </button>
                      <button className="button" onClick={selectAllRepos} disabled={!myRepos.length || isSyncingSelectedRepos}>
                        Select all
                      </button>
                      <button
                        className="button"
                        onClick={clearRepoSelection}
                        disabled={!selectedRepoNames.length || isSyncingSelectedRepos}
                      >
                        Clear selection
                      </button>
                      <button
                        className="button button-primary"
                        onClick={syncSelectedRepos}
                        disabled={!selectedRepoNames.length || isSyncingSelectedRepos || isLoadingMyRepos}
                      >
                        {isSyncingSelectedRepos ? 'Syncing selected...' : 'Sync Selected Repos'}
                      </button>
                    </div>

                    {myRepos.length ? (
                      <div className="repo-list" role="listbox" aria-label="Repository selection">
                        {myRepos.map((repo) => {
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
                      <p className="repo-hint">Load your repositories, then select multiple and sync docs only.</p>
                    )}
                  </div>
                ) : null}

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

                {repoStatus ? <p className="repo-status">{repoStatus}</p> : null}
              </section>
            </>
          ) : null}

          {activeView === 'settings' ? (
            <>
              <section className="settings-card">
                <div className="settings-card-header">
                  <div>
                    <p className="eyebrow">Configuration</p>
                    <h1>Settings</h1>
                    <p className="settings-description">Manage your library, import, and export settings.</p>
                  </div>
                </div>

                <div className="settings-divider" />
                <h2 className="settings-title">Upload Files</h2>
                <p className="settings-subtitle">Add markdown files and folders from your device.</p>

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
                        accept=".md,text/markdown"
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

          {activeView === 'help' ? (
            <section className="help-card">
              <h1>Help</h1>
              <p>Quick instructions to use the docs hub.</p>

              <ol className="help-list">
                <li>Use Dashboard as your reading area only.</li>
                <li>Open Git for login, pull, and repository sync controls.</li>
                <li>Open Settings for upload, import, and export controls.</li>
                <li>Use the sidebar to browse repositories, sections, and documents.</li>
                <li>Use Help for setup and troubleshooting steps anytime.</li>
              </ol>

              <h3>Troubleshooting</h3>
              <ul className="help-list">
                <li>If no docs import, verify the repository contains .md or .mdx files.</li>
                <li>If login fails, check Supabase GitHub provider configuration.</li>
                <li>If sync is slow, sync fewer repositories at a time.</li>
              </ul>
            </section>
          ) : null}
        </main>
      </div>

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
          Settings
        </button>
        <button
          className={`mobile-bottom-link ${activeView === 'help' ? 'mobile-bottom-link-active' : ''}`}
          type="button"
          onClick={() => setActiveView('help')}
        >
          Help
        </button>
      </nav>

      {isSectionsPanelOpen ? <button className="sidebar-scrim" onClick={() => setIsSectionsPanelOpen(false)} /> : null}
    </div>
  )
}

export default App
