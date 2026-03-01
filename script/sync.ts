#!/usr/bin/env bun

/**
 * Fork sync script: fetches upstream tags, rebases make-it-mine branch,
 * and cherry-picks patches from patches.json5.
 *
 * Usage:
 *   bun script/sync.ts [--tag <upstream-tag>] [--dry-run] [--force]
 *
 * Options:
 *   --tag <version>   Sync to a specific upstream tag (e.g. v0.3.17)
 *   --dry-run         Show what would be done without making changes
 *   --force           Force sync even if already up-to-date
 */

import { $ } from "bun"
import path from "path"

// Simple JSON5 parser for our limited use case (handles comments, trailing commas, unquoted keys)
function parseJson5(text: string): unknown {
  // Remove single-line comments (but not within strings)
  let cleaned = text.replace(/\/\/.*$/gm, "")
  // Remove multi-line comments
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "")
  // Remove trailing commas before } or ]
  cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1")
  // Quote unquoted keys (word characters followed by :)
  cleaned = cleaned.replace(/(\s*)(\w+)(\s*:)/g, '$1"$2"$3')
  return JSON.parse(cleaned)
}

const root = path.resolve(import.meta.dir, "..")
const args = process.argv.slice(2)

const dryRun = args.includes("--dry-run")
const force = args.includes("--force")
const tagIndex = args.indexOf("--tag")
const targetTag = tagIndex !== -1 ? args[tagIndex + 1] : undefined

interface Patch {
  pr: number
  description: string
}

interface PatchConfig {
  patches: Patch[]
  overrides?: Record<string, { add?: Patch[]; skip?: number[] }>
}

async function run(cmd: string[], opts?: { cwd?: string }) {
  const cwd = opts?.cwd ?? root
  if (dryRun) {
    console.log(`[dry-run] ${cmd.join(" ")}`)
    return ""
  }
  const result = await $`${cmd}`.cwd(cwd).text()
  return result.trim()
}

async function exec(cmd: string[], opts?: { cwd?: string }) {
  const cwd = opts?.cwd ?? root
  const result = await $`${cmd}`.cwd(cwd).nothrow().quiet()
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  }
}

async function getLatestUpstreamTag(): Promise<string> {
  await $`git fetch upstream --tags`.cwd(root).quiet()
  const tags = await $`git tag -l "v*" --sort=-v:refname`.cwd(root).text()
  const lines = tags.trim().split("\n").filter(Boolean)
  // Filter to semver tags only (v0.0.0 format, no prerelease)
  const semverTags = lines.filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
  if (semverTags.length === 0) throw new Error("No upstream semver tags found")
  return semverTags[0]
}

async function getLatestForkRelease(): Promise<string | null> {
  const result = await exec(["gh", "release", "list", "--limit", "1", "--json", "tagName"])
  if (result.exitCode !== 0) return null
  try {
    const releases = JSON.parse(result.stdout)
    if (releases.length === 0) return null
    return releases[0].tagName
  } catch {
    return null
  }
}

function extractBaseVersion(tag: string): string {
  // v0.3.17+brian.1 → v0.3.17
  // v0.3.17 → v0.3.17
  return tag.replace(/\+.*$/, "")
}

async function loadPatches(): Promise<PatchConfig> {
  const file = Bun.file(path.join(root, "patches.json5"))
  const text = await file.text()
  return parseJson5(text) as PatchConfig
}

function getPatchesForVersion(config: PatchConfig, version: string): Patch[] {
  const base = config.patches ?? []
  const override = config.overrides?.[version]
  if (!override) return base

  const skip = new Set(override.skip ?? [])
  const filtered = base.filter((p) => !skip.has(p.pr))
  const added = override.add ?? []
  return [...filtered, ...added]
}

interface PrInfo {
  state: "open" | "closed" | "merged"
  mergeCommit: string | null
  headSha: string
  commits: number
}

async function getPrInfo(pr: number): Promise<PrInfo | null> {
  // Fetch PR info from GitHub API
  const result = await exec([
    "gh",
    "api",
    `repos/anomalyco/opencode/pulls/${pr}`,
    "--jq",
    "{state: .state, merged: .merged, mergeCommit: .merge_commit_sha, headSha: .head.sha, commits: .commits}",
  ])
  if (result.exitCode !== 0 || !result.stdout) return null
  try {
    const data = JSON.parse(result.stdout)
    return {
      state: data.merged ? "merged" : data.state,
      mergeCommit: data.mergeCommit || null,
      headSha: data.headSha,
      commits: data.commits,
    }
  } catch {
    return null
  }
}

async function cherryPickPr(pr: number): Promise<{ success: boolean; error?: string }> {
  const info = await getPrInfo(pr)
  if (!info) {
    return { success: false, error: `Could not fetch info for PR #${pr}` }
  }

  console.log(`   PR #${pr} state: ${info.state}, commits: ${info.commits}`)

  // For merged PRs, use the merge commit if available
  if (info.state === "merged" && info.mergeCommit) {
    await $`git fetch upstream ${info.mergeCommit}`.cwd(root).nothrow().quiet()

    if (dryRun) {
      console.log(`[dry-run] git cherry-pick ${info.mergeCommit} (PR #${pr}, merged)`)
      return { success: true }
    }

    const result = await exec(["git", "cherry-pick", "--no-commit", info.mergeCommit])
    if (result.exitCode !== 0) {
      await $`git cherry-pick --abort`.cwd(root).nothrow().quiet()
      return { success: false, error: result.stderr || "Cherry-pick failed" }
    }

    await $`git commit -m ${"patch: PR #" + pr}`.cwd(root).quiet()
    return { success: true }
  }

  // For open PRs, fetch the PR branch and cherry-pick all its commits
  console.log(`   Fetching PR #${pr} branch...`)
  const fetchResult = await $`git fetch upstream pull/${pr}/head:pr-${pr}`.cwd(root).nothrow().quiet()
  if (fetchResult.exitCode !== 0) {
    return { success: false, error: `Failed to fetch PR #${pr} branch` }
  }

  if (dryRun) {
    console.log(`[dry-run] git cherry-pick pr-${pr}~${info.commits}..pr-${pr} (PR #${pr}, open)`)
    return { success: true }
  }

  // Cherry-pick all commits from the PR
  // We use the commit range from the PR's base to its head
  const result = await exec(["git", "cherry-pick", "--no-commit", `pr-${pr}~${info.commits}..pr-${pr}`])
  if (result.exitCode !== 0) {
    await $`git cherry-pick --abort`.cwd(root).nothrow().quiet()
    return { success: false, error: result.stderr || "Cherry-pick failed" }
  }

  await $`git commit -m ${"patch: PR #" + pr}`.cwd(root).quiet()

  // Clean up the temporary branch
  await $`git branch -D pr-${pr}`.cwd(root).nothrow().quiet()

  return { success: true }
}

async function getCurrentBranch(): Promise<string> {
  return (await $`git branch --show-current`.cwd(root).text()).trim()
}

async function hasUncommittedChanges(): Promise<boolean> {
  const result = await $`git status --porcelain`.cwd(root).text()
  return result.trim().length > 0
}

async function main() {
  console.log("🔄 Fork sync script")
  console.log(`   Root: ${root}`)
  console.log(`   Dry run: ${dryRun}`)
  console.log(`   Force: ${force}`)
  console.log()

  // Check for uncommitted changes
  if (await hasUncommittedChanges()) {
    console.error("❌ Uncommitted changes detected. Please commit or stash them first.")
    process.exit(1)
  }

  // Determine target tag
  const upstreamTag = targetTag ?? (await getLatestUpstreamTag())
  console.log(`📦 Target upstream tag: ${upstreamTag}`)

  // Check current fork release
  const forkRelease = await getLatestForkRelease()
  if (forkRelease) {
    const forkBase = extractBaseVersion(forkRelease)
    console.log(`📦 Latest fork release: ${forkRelease} (base: ${forkBase})`)
    if (forkBase === upstreamTag && !force) {
      console.log("✅ Already up-to-date with upstream. Use --force to re-sync.")
      process.exit(0)
    }
  } else {
    console.log("📦 No existing fork releases found")
  }

  // Load patches
  const config = await loadPatches()
  const version = upstreamTag.replace(/^v/, "")
  const patches = getPatchesForVersion(config, version)
  console.log(`📋 Patches to apply: ${patches.length}`)
  patches.forEach((p) => console.log(`   - PR #${p.pr}: ${p.description}`))
  console.log()

  // Save current branch to restore later
  const originalBranch = await getCurrentBranch()

  // Reset make-it-mine to upstream tag
  console.log(`🔀 Resetting make-it-mine to ${upstreamTag}...`)
  if (!dryRun) {
    await $`git checkout -B make-it-mine ${upstreamTag}`.cwd(root)
  } else {
    console.log(`[dry-run] git checkout -B make-it-mine ${upstreamTag}`)
  }

  // The fork-specific patches (installation URL changes) are already in the working tree
  // because this script lives on make-it-mine. We need to apply them as the first commit.
  // Since we just reset to the upstream tag, we need to cherry-pick our fork patches.
  //
  // Strategy: The fork patches are expected to be committed separately. After running
  // this script, commit any changes to installation/index.ts manually, then push.
  // On subsequent syncs, we can identify the "fork base commit" and cherry-pick it.
  //
  // For now, we'll just apply PR patches. The user should ensure their fork-specific
  // changes (like the installation URL edits) are present in the working tree.

  // Apply PR patches
  const failed: { pr: number; error: string }[] = []
  for (const patch of patches) {
    console.log(`🍒 Cherry-picking PR #${patch.pr}...`)
    const result = await cherryPickPr(patch.pr)
    if (!result.success) {
      console.error(`   ❌ Failed: ${result.error}`)
      failed.push({ pr: patch.pr, error: result.error ?? "Unknown error" })
    } else {
      console.log(`   ✅ Applied`)
    }
  }

  if (failed.length > 0) {
    console.error()
    console.error("❌ Some patches failed to apply:")
    failed.forEach((f) => console.error(`   PR #${f.pr}: ${f.error}`))
    console.error()
    console.error("The make-it-mine branch has been partially updated.")
    console.error("Please resolve conflicts manually or remove failing PRs from patches.json5.")

    // Output for GitHub Actions
    if (process.env.GITHUB_OUTPUT) {
      const output = ["success=false", `failed_prs=${failed.map((f) => f.pr).join(",")}`, `upstream_tag=${upstreamTag}`]
      await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
    }
    process.exit(1)
  }

  console.log()
  console.log("✅ Sync complete!")
  console.log(`   Branch make-it-mine is now based on ${upstreamTag}`)
  console.log(`   ${patches.length} patches applied`)
  console.log()
  console.log("Next steps:")
  console.log("   1. Review changes: git log --oneline make-it-mine")
  console.log("   2. Push: git push origin make-it-mine --force-with-lease")

  // Output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    const output = ["success=true", `upstream_tag=${upstreamTag}`, `patches_applied=${patches.length}`]
    await Bun.write(process.env.GITHUB_OUTPUT, output.join("\n"))
  }
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
