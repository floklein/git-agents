import { $ } from "bun";

type ShellResult = { ok: boolean; output?: string; error?: string };

export async function checkGhInstalled(): Promise<ShellResult> {
  try {
    const result = await $`gh --version`.quiet();
    return { ok: result.exitCode === 0, output: result.stdout.toString() };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "gh not found" };
  }
}

export async function checkGhAuth(): Promise<ShellResult> {
  try {
    const result = await $`gh auth status`.quiet();
    return { ok: result.exitCode === 0 };
  } catch {
    return { ok: false, error: "Not authenticated. Run: gh auth login" };
  }
}

export async function ghRepoExists(name: string): Promise<ShellResult> {
  try {
    const result = await $`gh repo view ${name}`.quiet();
    return { ok: result.exitCode === 0 };
  } catch {
    return { ok: false };
  }
}

export async function ghCreateRepo(name: string): Promise<ShellResult> {
  try {
    const result = await $`gh repo create ${name} --private`.quiet();
    return { ok: result.exitCode === 0, output: result.stdout.toString() };
  } catch (e: any) {
    return { ok: false, error: e.stderr?.toString() ?? e.message };
  }
}

export async function ghGetRepoCloneUrl(name: string): Promise<ShellResult> {
  try {
    const result = await $`gh repo view ${name} --json sshUrl --jq .sshUrl`.quiet();
    const url = result.stdout.toString().trim();
    return { ok: !!url, output: url };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function checkGitRepoExists(url: string): Promise<ShellResult> {
  try {
    const result = await $`git ls-remote ${url}`.quiet();
    return { ok: result.exitCode === 0 };
  } catch {
    return { ok: false, error: "Cannot reach repository" };
  }
}

export async function cloneRepo(url: string, dest: string): Promise<ShellResult> {
  try {
    const result = await $`git clone ${url} ${dest}`.quiet();
    return { ok: result.exitCode === 0 };
  } catch (e: any) {
    return { ok: false, error: e.stderr?.toString() ?? e.message };
  }
}

export async function gitPull(dir: string): Promise<ShellResult> {
  try {
    const result = await $`git -C ${dir} pull`.quiet();
    return { ok: result.exitCode === 0, output: result.stdout.toString() };
  } catch (e: any) {
    const stderr = e.stderr?.toString() ?? e.message ?? "";
    // Remote is empty (freshly created repo) — treat as no-op
    if (stderr.includes("no such ref was fetched") || stderr.includes("couldn't find remote ref")) {
      return { ok: true, output: "Remote is empty" };
    }
    return { ok: false, error: stderr };
  }
}

export async function gitAddCommitPush(dir: string, message: string): Promise<ShellResult> {
  try {
    await $`git -C ${dir} add -A`.quiet();
    const status = await $`git -C ${dir} status --porcelain`.quiet();
    if (!status.stdout.toString().trim()) {
      return { ok: true, output: "Nothing to commit" };
    }
    await $`git -C ${dir} commit -m ${message}`.quiet();
    const push = await $`git -C ${dir} push -u origin HEAD`.quiet();
    return { ok: push.exitCode === 0 };
  } catch (e: any) {
    return { ok: false, error: e.stderr?.toString() ?? e.message };
  }
}

export async function initRepo(dir: string): Promise<ShellResult> {
  try {
    await $`git -C ${dir} init`.quiet();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
