/**
 * GitHub Embedding Cache
 * Stores embedding indexes in GitHub for cross-device reuse
 */

const EMBEDDINGS_FILE_NAME = 'embeddings-index.json'
const CACHE_META_FILE_NAME = 'embeddings-meta.json'

async function getGitHubToken() {
  // Get stored GitHub token from localStorage (set after GitHub OAuth login)
  const token = localStorage.getItem('docs-site.github-provider-token.v1')
  return token
}

async function fetchGitHubFile(owner, repo, filePath, token) {
  if (!token) {
    console.warn('No GitHub token available')
    return null
  }

  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3.raw',
      },
    })

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`)
    }

    return await response.text()
  } catch (error) {
    console.error('Failed to fetch from GitHub:', error)
    return null
  }
}

async function pushGitHubFile(owner, repo, filePath, content, message, token) {
  if (!token) {
    console.warn('No GitHub token available for GitHub cache push')
    return null
  }

  try {
    // First, get the current SHA if file exists
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`
    let sha = null

    const getResponse = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    })

    if (getResponse.ok) {
      const data = await getResponse.json()
      sha = data.sha
    }

    // Prepare the content (base64 encoded)
    const encodedContent = btoa(unescape(encodeURIComponent(content)))

    const body = {
      message,
      content: encodedContent,
    }

    if (sha) {
      body.sha = sha
    }

    const pushResponse = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!pushResponse.ok) {
      throw new Error(`GitHub API error: ${pushResponse.status}`)
    }

    return await pushResponse.json()
  } catch (error) {
    console.error('Failed to push to GitHub:', error)
    return null
  }
}

export async function pullEmbeddingsFromGitHub(owner, repo) {
  const token = await getGitHubToken()
  if (!token) {
    return { embeddings: [], meta: null }
  }

  try {
    const content = await fetchGitHubFile(owner, repo, EMBEDDINGS_FILE_NAME, token)
    if (!content) {
      return { embeddings: [], meta: null }
    }

    const data = JSON.parse(content)
    const metaContent = await fetchGitHubFile(owner, repo, CACHE_META_FILE_NAME, token)
    const meta = metaContent ? JSON.parse(metaContent) : null

    return {
      embeddings: Array.isArray(data) ? data : [],
      meta,
    }
  } catch (error) {
    console.error('Failed to parse embeddings from GitHub:', error)
    return { embeddings: [], meta: null }
  }
}

export async function pushEmbeddingsToGitHub(embeddings, owner, repo, meta = null) {
  const token = await getGitHubToken()
  if (!token) {
    console.warn('No GitHub token for pushing embeddings')
    return null
  }

  try {
    // Push embeddings file
    const content = JSON.stringify(embeddings, null, 2)
    const timestamp = new Date().toISOString()
    const message = `[DOC-CACHE] Update embedding index (${embeddings.length} embeddings) at ${timestamp}`

    const result = await pushGitHubFile(owner, repo, EMBEDDINGS_FILE_NAME, content, message, token)

    // Push metadata
    if (meta) {
      const metaContent = JSON.stringify(
        { ...meta, updatedAt: timestamp, version: '1' },
        null,
        2,
      )
      const metaMessage = `[DOC-CACHE] Update embedding metadata at ${timestamp}`
      await pushGitHubFile(owner, repo, CACHE_META_FILE_NAME, metaContent, metaMessage, token)
    }

    return result
  } catch (error) {
    console.error('Failed to push embeddings to GitHub:', error)
    return null
  }
}

export async function syncEmbeddingsWithGitHub(
  currentEmbeddings,
  owner,
  repo,
  pushAfterSync = true,
) {
  try {
    const { embeddings: cachedEmbeddings, meta } = await pullEmbeddingsFromGitHub(owner, repo)

    // Merge with priority to local (newer) embeddings
    const mergedMap = new Map()

    // Add cached from GitHub
    for (const emb of cachedEmbeddings) {
      if (emb.modelHash) {
        mergedMap.set(emb.modelHash, emb)
      }
    }

    // Override with current (local) embeddings
    for (const emb of currentEmbeddings) {
      if (emb.modelHash) {
        mergedMap.set(emb.modelHash, emb)
      }
    }

    const merged = Array.from(mergedMap.values())

    // Optionally push merged back to GitHub
    if (pushAfterSync && merged.length > 0) {
      await pushEmbeddingsToGitHub(merged, owner, repo, {
        totalEmbeddings: merged.length,
        lastSyncDevice: 'browser',
        deviceTimestamp: new Date().toISOString(),
      })
    }

    return {
      merged,
      cachedCount: cachedEmbeddings.length,
      currentCount: currentEmbeddings.length,
      mergedCount: merged.length,
    }
  } catch (error) {
    console.error('Failed to sync embeddings with GitHub:', error)
    return {
      merged: currentEmbeddings,
      error: error.message,
    }
  }
}
