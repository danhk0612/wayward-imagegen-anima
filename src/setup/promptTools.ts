/**
 * Small, model-agnostic helpers for turning real Wayward prompts into setup
 * suggestions. Suggestions are deliberately conservative: callers decide
 * whether to apply them.
 */

export interface PromptPrefixAnalysis {
  sampleCount: number
  candidatePrefix: string
  commonTagCount: number
  latestPrompt: string
  samples: string[]
}

export function splitPromptTags(prompt: string): string[] {
  return prompt
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)
}

function comparable(tag: string): string {
  return tag.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Find the longest comma-tag prefix shared by distinct prompt samples.
 *
 * This matches the way Wayward builds prompts: stable character identity tags
 * lead the prompt and scene/outfit/action tags change later. We require at
 * least two distinct samples before returning a candidate so one scene is
 * never mistaken for a permanent identity.
 */
export function analysePromptPrefix(prompts: string[], maxSamples = 20): PromptPrefixAnalysis {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const raw of prompts) {
    const prompt = raw.trim()
    if (!prompt || seen.has(prompt)) continue
    seen.add(prompt)
    unique.push(prompt)
    if (unique.length >= maxSamples) break
  }

  const latestPrompt = unique[0] ?? ''
  if (unique.length < 2) {
    return {
      sampleCount: unique.length,
      candidatePrefix: '',
      commonTagCount: 0,
      latestPrompt,
      samples: unique,
    }
  }

  const split = unique.map(splitPromptTags)
  const shortest = Math.min(...split.map(tags => tags.length))
  let common = 0
  for (; common < shortest; common++) {
    const wanted = comparable(split[0][common])
    if (!split.every(tags => comparable(tags[common]) === wanted)) break
  }

  return {
    sampleCount: unique.length,
    candidatePrefix: split[0].slice(0, common).join(', '),
    commonTagCount: common,
    latestPrompt,
    samples: unique,
  }
}
