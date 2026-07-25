import { existsSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import BigText from "ink-big-text";
import TextInput from "ink-text-input";
import { SelectMenu } from "../components/SelectMenu";
import {
  checkGhInstalled,
  checkGhAuth,
  ghRepoExists,
  ghCreateRepo,
  ghGetRepoCloneUrl,
  checkGitRepoExists,
  cloneRepo,
  gitSetRemoteUrl,
} from "../utils/shell";
import { writeConfig, CONFIG_DIR } from "../utils/config";
import {
  runGhPrecheck,
  runGhRepoCheck,
  runGhCreateRepo,
  runClone,
  runGitUrlValidation,
} from "../utils/flows";
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
  | "error";

type Props = {
  existingConfig?: Config;
  onComplete: (config: Config) => void;
};

const GH_REPO_NAME = "git-agents-remote";
const MAX_GIT_URL_LENGTH = 1000;

function sanitizeGitUrl(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\r\n]/g, "")
    .slice(0, MAX_GIT_URL_LENGTH);
}

const REMOTE_ITEMS = [
  {
    name: "GitHub CLI (gh)",
    description: "Auto-create and manage a private GitHub repo",
    value: "gh",
  },
  {
    name: "Custom Git Repo",
    description: "Use any existing remote git repository",
    value: "git",
  },
] as const;

export function SetupScreen({ existingConfig, onComplete }: Props) {
  const [step, setStep] = useState<SetupStep>("welcome");
  const [selectedRemote, setSelectedRemote] = useState<RemoteType>(
    existingConfig?.remote ?? "gh",
  );
  const [gitUrl, setGitUrl] = useState(existingConfig?.repoUrl ?? "");
  const [repoCloneUrl, setRepoCloneUrl] = useState("");
  const [ghRepoExistedBefore, setGhRepoExistedBefore] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [statusMsg, setStatusMsg] = useState("");

  useInput((_input, key) => {
    if (step === "welcome" && key.return) {
      setStep("choose-remote");
    }

    if (step === "gh-auth-needed" && key.return) {
      void recheckGhAuth();
    }

    if (step === "error" && key.return) {
      setStep("choose-remote");
    }

    if (step === "git-url-input" && key.escape) {
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
    void proceedGhRepoCheck();
  }

  const shellDeps = {
    checkGhInstalled,
    checkGhAuth,
    ghRepoExists,
    ghCreateRepo,
    ghGetRepoCloneUrl,
    checkGitRepoExists,
    cloneRepo: (url: string) => cloneRepo(url, CONFIG_DIR),
    isAlreadyCloned: () => existsSync(join(CONFIG_DIR, ".git")),
    writeConfig,
    gitSetRemoteUrl,
  };

  async function startGhFlow() {
    setStep("gh-checking");
    setStatusMsg("Checking gh CLI...");
    const result = await runGhPrecheck(shellDeps);
    if (result.type === "gh-not-installed") {
      setErrorMsg(
        "GitHub CLI (gh) is not installed. Install it from https://cli.github.com and try again.",
      );
      setStep("error");
      return;
    }
    if (result.type === "needs-auth") {
      setStep("gh-auth-needed");
      return;
    }
    void proceedGhRepoCheck();
  }

  async function proceedGhRepoCheck() {
    setStep("gh-checking");
    setStatusMsg("Checking for git-agents repo...");
    const result = await runGhRepoCheck(GH_REPO_NAME, shellDeps);
    if (result.type === "error") {
      setErrorMsg(result.message);
      setStep("error");
      return;
    }
    if (result.type === "not-found") {
      setGhRepoExistedBefore(false);
      setStep("gh-repo-check");
      return;
    }
    setGhRepoExistedBefore(true);
    setRepoCloneUrl(result.url);
    setStep("gh-confirm");
  }

  async function createGhRepoAndContinue() {
    setStep("gh-checking");
    setStatusMsg(`Creating private repo "${GH_REPO_NAME}"...`);
    const result = await runGhCreateRepo(GH_REPO_NAME, shellDeps);
    if (result.type === "error") {
      setErrorMsg(result.message);
      setStep("error");
      return;
    }
    setRepoCloneUrl(result.url);
    setStep("gh-confirm");
  }

  async function startClone(url: string, remote: RemoteType) {
    setStep("cloning");
    setStatusMsg(`Cloning ${url}...`);
    const result = await runClone(url, remote, CONFIG_DIR, shellDeps);
    if (result.type === "error") {
      setErrorMsg(result.message);
      setStep("error");
      return;
    }
    onComplete(result.config);
  }

  async function validateGitUrl(url: string) {
    setStep("git-url-checking");
    setStatusMsg("Validating repository...");
    const result = await runGitUrlValidation(url, shellDeps);
    if (result.type === "error") {
      setErrorMsg(
        `${result.message}\nMake sure the URL is correct and you have access.`,
      );
      setStep("error");
      return;
    }
    await startClone(url, "git");
  }

  if (step === "welcome") {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        <BigText text="git-agents" font="tiny" />
        <Box flexDirection="column" alignItems="center" width={60} marginTop={1}>
          <Text>Sync your AI agent skills with a remote git repo.</Text>
          <Text dimColor>
            Keeps your AI agents in sync across machines using git.
          </Text>
        </Box>
        <Box marginTop={2}>
          <Text dimColor>Press </Text>
          <Text>Enter</Text>
          <Text dimColor> to start setup</Text>
        </Box>
      </Box>
    );
  }

  if (step === "choose-remote") {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        <Text>Choose how to connect your remote:</Text>
        <Box flexDirection="column" width={68} marginTop={1}>
          <SelectMenu
            key="choose-remote"
            options={REMOTE_ITEMS}
            initialIndex={selectedRemote === "gh" ? 0 : 1}
            onSelect={(item) => {
              const remote: RemoteType = item.value;
              setSelectedRemote(remote);
              if (remote === "gh") {
                void startGhFlow();
              } else {
                setStep("git-url-input");
              }
            }}
          />
        </Box>
        <Text dimColor>↑↓ navigate  Enter select</Text>
      </Box>
    );
  }

  if (step === "gh-checking") {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        <Text>{statusMsg}</Text>
      </Box>
    );
  }

  if (step === "gh-auth-needed") {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        <Text color="#ffb86c">Not authenticated with GitHub CLI.</Text>
        <Box
          borderStyle="round"
          paddingX={2}
          paddingY={1}
          marginTop={1}
        >
          <Text dimColor>Run in another terminal: </Text>
          <Text color="#50fa7b">gh auth login</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press </Text>
          <Text>Enter</Text>
          <Text dimColor> once authenticated to continue</Text>
        </Box>
      </Box>
    );
  }

  if (step === "gh-repo-check") {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        <Text>
          Repo <Text color="#8be9fd">"{GH_REPO_NAME}"</Text> does not exist on
          your GitHub account.
        </Text>
        <Box flexDirection="column" width={60} marginTop={1}>
          <SelectMenu
            key="gh-repo-check"
            options={[
              {
                name: `Create private repo "${GH_REPO_NAME}"`,
                description: "Recommended",
                value: "create",
              },
              {
                name: "Cancel",
                description: "Go back to remote selection",
                value: "cancel",
              },
            ] as const}
            onSelect={(item) => {
              if (item.value === "create") {
                void createGhRepoAndContinue();
              } else {
                setStep("choose-remote");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "gh-confirm") {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        <Text color="#50fa7b">
          {ghRepoExistedBefore ? "Found existing repo!" : "Repository ready!"}
        </Text>
        <Box
          borderStyle="round"
          paddingX={2}
          paddingY={1}
          flexDirection="column"
          marginTop={1}
        >
          <Text>
            <Text dimColor>Repo: </Text>
            <Text color="#8be9fd">{repoCloneUrl}</Text>
          </Text>
          <Text>
            <Text dimColor>Will clone to: </Text>
            <Text>~/.git-agents</Text>
          </Text>
        </Box>
        <Box flexDirection="column" width={52} marginTop={1}>
          <SelectMenu
            key="gh-confirm"
            options={[
              {
                name: "Continue",
                description: "Clone repo and save config",
                value: "continue",
              },
              {
                name: "Cancel",
                description: "Go back to remote selection",
                value: "cancel",
              },
            ] as const}
            onSelect={(item) => {
              if (item.value === "continue") {
                void startClone(repoCloneUrl, "gh");
              } else {
                setStep("choose-remote");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (step === "git-url-input") {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        <Text>Enter the Git repository URL:</Text>
        <Box
          borderStyle="round"
          paddingX={2}
          paddingY={1}
          width={60}
          marginTop={1}
        >
          <TextInput
            focus
            placeholder="git@github.com:user/repo.git"
            value={gitUrl}
            onChange={(value) => setGitUrl(sanitizeGitUrl(value))}
            onSubmit={(value) => {
              const url = sanitizeGitUrl(value).trim();
              if (url) void validateGitUrl(url);
            }}
          />
        </Box>
        <Text dimColor>Enter to confirm  Esc to go back</Text>
      </Box>
    );
  }

  if (step === "git-url-checking" || step === "cloning") {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        <Text>{statusMsg}</Text>
      </Box>
    );
  }

  if (step === "error") {
    return (
      <Box
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        flexGrow={1}
      >
        <Text color="#ff5555">{errorMsg}</Text>
        <Box marginTop={2}>
          <Text dimColor>Press </Text>
          <Text>Enter</Text>
          <Text dimColor> to try again</Text>
        </Box>
      </Box>
    );
  }

  return null;
}
