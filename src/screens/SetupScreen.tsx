import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import {
  checkGhInstalled,
  checkGhAuth,
  ghRepoExists,
  ghCreateRepo,
  ghGetRepoCloneUrl,
  checkGitRepoExists,
  cloneRepo,
} from "../utils/shell";
import { writeConfig, CONFIG_DIR } from "../utils/config";
import { existsSync } from "fs";
import { join } from "path";
import type { Config, RemoteType } from "../types";

type SetupStep =
  | "welcome"
  | "choose-remote"
  | "gh-checking"
  | "gh-auth-needed"
  | "gh-repo-check"
  | "gh-confirm"
  | "git-url-input"
  | "git-url-checking"
  | "cloning"
  | "done"
  | "error";

type Props = {
  existingConfig?: Config;
  onComplete: (config: Config) => void;
};

const GH_REPO_NAME = "git-agents-remote";

export function SetupScreen({ existingConfig, onComplete }: Props) {
  const [step, setStep] = useState<SetupStep>("welcome");
  const [selectedRemote, setSelectedRemote] = useState<RemoteType>(
    existingConfig?.remote ?? "gh"
  );
  const [gitUrl, setGitUrl] = useState(existingConfig?.repoUrl ?? "");
  const [repoCloneUrl, setRepoCloneUrl] = useState("");
  const [ghRepoExistedBefore, setGhRepoExistedBefore] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [statusMsg, setStatusMsg] = useState("");

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") process.exit(0);

    if (step === "welcome" && key.name === "return") {
      setStep("choose-remote");
    }

    if (step === "gh-auth-needed" && key.name === "return") {
      recheckGhAuth();
    }

    if (step === "error" && key.name === "return") {
      setStep("choose-remote");
    }
  });

  async function recheckGhAuth() {
    setStep("gh-checking");
    setStatusMsg("Checking gh auth...");
    const auth = await checkGhAuth();
    if (!auth.ok) {
      setStep("gh-auth-needed");
      return;
    }
    proceedGhRepoCheck();
  }

  async function startGhFlow() {
    setStep("gh-checking");
    setStatusMsg("Checking gh CLI...");

    const ghInstalled = await checkGhInstalled();
    if (!ghInstalled.ok) {
      setErrorMsg("GitHub CLI (gh) is not installed. Install it from https://cli.github.com and try again.");
      setStep("error");
      return;
    }

    const auth = await checkGhAuth();
    if (!auth.ok) {
      setStep("gh-auth-needed");
      return;
    }

    proceedGhRepoCheck();
  }

  async function proceedGhRepoCheck() {
    setStep("gh-checking");
    setStatusMsg("Checking for git-agents repo...");

    const exists = await ghRepoExists(GH_REPO_NAME);
    setGhRepoExistedBefore(exists.ok);

    if (!exists.ok) {
      setStep("gh-repo-check");
      return;
    }

    const urlResult = await ghGetRepoCloneUrl(GH_REPO_NAME);
    if (!urlResult.ok || !urlResult.output) {
      setErrorMsg("Could not get repo URL from gh CLI.");
      setStep("error");
      return;
    }
    setRepoCloneUrl(urlResult.output.trim());
    setStep("gh-confirm");
  }

  async function createGhRepoAndContinue() {
    setStep("gh-checking");
    setStatusMsg(`Creating private repo "${GH_REPO_NAME}"...`);

    const created = await ghCreateRepo(GH_REPO_NAME);
    if (!created.ok) {
      setErrorMsg(`Failed to create repo: ${created.error ?? "unknown error"}`);
      setStep("error");
      return;
    }

    const urlResult = await ghGetRepoCloneUrl(GH_REPO_NAME);
    if (!urlResult.ok || !urlResult.output) {
      setErrorMsg("Could not get repo URL after creating it.");
      setStep("error");
      return;
    }
    setRepoCloneUrl(urlResult.output.trim());
    setStep("gh-confirm");
  }

  async function startClone(url: string, remote: RemoteType) {
    setStep("cloning");
    setStatusMsg(`Cloning ${url}...`);

    const config: Config = { remote, repoUrl: remote === "git" ? url : undefined };

    // If already cloned, skip clone
    if (existsSync(join(CONFIG_DIR, ".git"))) {
      writeConfig(config);
      setStep("done");
      return;
    }

    const result = await cloneRepo(url, CONFIG_DIR);
    if (!result.ok) {
      setErrorMsg(`Failed to clone: ${result.error ?? "unknown error"}`);
      setStep("error");
      return;
    }

    writeConfig(config);
    setStep("done");
  }

  async function validateGitUrl(url: string) {
    setStep("git-url-checking");
    setStatusMsg("Validating repository...");

    const exists = await checkGitRepoExists(url);
    if (!exists.ok) {
      setErrorMsg(`Cannot reach repository: ${url}\nMake sure the URL is correct and you have access.`);
      setStep("error");
      return;
    }

    await startClone(url, "git");
  }

  useEffect(() => {
    if (step === "done") {
      const config: Config = {
        remote: selectedRemote,
        repoUrl: selectedRemote === "git" ? repoCloneUrl || gitUrl : undefined,
      };
      onComplete(config);
    }
  }, [step]);

  // ---- Render ----

  if (step === "welcome") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} gap={2}>
        <ascii-font font="tiny" text="git-agents" />
        <box flexDirection="column" alignItems="center" gap={1} width={60}>
          <text>Sync your Claude agents skills with a remote git repo.</text>
          <text attributes={TextAttributes.DIM}>
            Keeps ~/.agents in sync across machines using git.
          </text>
        </box>
        <text>
          <span attributes={TextAttributes.DIM}>Press </span>
          <span>Enter</span>
          <span attributes={TextAttributes.DIM}> to start setup</span>
        </text>
      </box>
    );
  }

  if (step === "choose-remote") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} gap={2}>
        <text>Choose how to connect your remote:</text>
        <select
          focused={true}
          options={[
            {
              name: "GitHub CLI (gh)",
              description: "Auto-create and manage a private GitHub repo",
            },
            {
              name: "Custom Git Repo",
              description: "Use any existing remote git repository",
            },
          ]}
          selectedIndex={selectedRemote === "gh" ? 0 : 1}
          onSelect={(index) => {
            const remote: RemoteType = index === 0 ? "gh" : "git";
            setSelectedRemote(remote);
            if (remote === "gh") {
              startGhFlow();
            } else {
              setStep("git-url-input");
            }
          }}
          width={50}
        />
        <text attributes={TextAttributes.DIM}>↑↓ navigate  Enter select</text>
      </box>
    );
  }

  if (step === "gh-checking") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <text>{statusMsg}</text>
      </box>
    );
  }

  if (step === "gh-auth-needed") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} gap={2}>
        <text fg="#ffb86c">Not authenticated with GitHub CLI.</text>
        <box border={true} borderStyle="rounded" paddingX={2} paddingY={1}>
          <text>
            <span attributes={TextAttributes.DIM}>Run in another terminal: </span>
            <span fg="#50fa7b">gh auth login</span>
          </text>
        </box>
        <text>
          <span attributes={TextAttributes.DIM}>Press </span>
          <span>Enter</span>
          <span attributes={TextAttributes.DIM}> once authenticated to continue</span>
        </text>
      </box>
    );
  }

  if (step === "gh-repo-check") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} gap={2}>
        <text>
          Repo <span fg="#8be9fd">"{GH_REPO_NAME}"</span> does not exist on your GitHub account.
        </text>
        <select
          focused={true}
          options={[
            { name: `Create private repo "${GH_REPO_NAME}"`, description: "Recommended" },
            { name: "Cancel", description: "Go back to remote selection" },
          ]}
          onSelect={(index) => {
            if (index === 0) createGhRepoAndContinue();
            else setStep("choose-remote");
          }}
          width={50}
        />
      </box>
    );
  }

  if (step === "gh-confirm") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} gap={2}>
        <text fg="#50fa7b">
          {ghRepoExistedBefore ? "Found existing repo!" : "Repository ready!"}
        </text>
        <box border={true} borderStyle="rounded" paddingX={2} paddingY={1} flexDirection="column" gap={1}>
          <text>
            <span attributes={TextAttributes.DIM}>Repo: </span>
            <span fg="#8be9fd">{repoCloneUrl}</span>
          </text>
          <text>
            <span attributes={TextAttributes.DIM}>Will clone to: </span>
            <span>~/.git-agents</span>
          </text>
        </box>
        <select
          focused={true}
          options={[
            { name: "Continue", description: "Clone repo and save config" },
            { name: "Cancel", description: "Go back to remote selection" },
          ]}
          onSelect={(index) => {
            if (index === 0) startClone(repoCloneUrl, "gh");
            else setStep("choose-remote");
          }}
          width={40}
        />
      </box>
    );
  }

  if (step === "git-url-input") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} gap={2}>
        <text>Enter the Git repository URL:</text>
        <box border={true} borderStyle="rounded" paddingX={2} paddingY={1} width={60}>
          <input
            focused={true}
            placeholder="git@github.com:user/repo.git"
            value={gitUrl}
            onInput={setGitUrl}
            onSubmit={() => {
              if (gitUrl.trim()) validateGitUrl(gitUrl.trim());
            }}
            flexGrow={1}
          />
        </box>
        <text attributes={TextAttributes.DIM}>Enter to confirm  Esc to go back</text>
      </box>
    );
  }

  if (step === "git-url-checking") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <text>{statusMsg}</text>
      </box>
    );
  }

  if (step === "cloning") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <text>{statusMsg}</text>
      </box>
    );
  }

  if (step === "error") {
    return (
      <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} gap={2}>
        <text fg="#ff5555">{errorMsg}</text>
        <text>
          <span attributes={TextAttributes.DIM}>Press </span>
          <span>Enter</span>
          <span attributes={TextAttributes.DIM}> to try again</span>
        </text>
      </box>
    );
  }

  return null;
}
