// ==UserScript==
// @name        Nixpkgs PR Branch Tracker
// @namespace   UserScripts
// @version     0.2.1
// @description Enhances GitHub PR pages by displaying merge commit hashes and tracking branch propagation for NixOS/nixpkgs.
// @author      Bryan Lai <bryanlais@gmail.com>
// @author      Leonard Sheng Sheng Lee <305414+sheeeng@users.noreply.github.com>
// @match       https://github.com/*
// @icon        https://www.google.com/s2/favicons?sz=64&domain=github.com
// @connect     api.github.com
// @grant       GM_getValue
// @grant       GM_registerMenuCommand
// @grant       GM_setValue
// @grant       GM_xmlhttpRequest
// @inject-into content
// @sandbox     DOM
// @run-at      document-idle
// ==/UserScript==

/**
 * This UserScript enhances GitHub pull request pages for the NixOS/nixpkgs repository.
 *
 * Main Features:
 * 1. Displays the merge commit hash in the PR header for easy reference.
 * 2. For merged PRs, tracks whether the commit has propagated to important branches:
 *    - master: Main development branch where PRs are merged first.
 *    - staging-next: Staging area for large rebuilds before merging to master.
 *    - nixpkgs-unstable: Continuously updated from master after CI passes (for general packages).
 *    - nixos-unstable: Like nixpkgs-unstable but includes NixOS tests.
 *    - nixos-unstable-small: Fast-track channel for small, critical updates.
 * 3. Provides visual indicators (✅/⚠️) to show merge status for each branch.
 * 4. Supports GitHub API authentication to avoid rate limits.
 *
 * The script runs in the userscript manager sandbox (`@inject-into content`,
 * `@sandbox DOM`) because the GitHub Content Security Policy blocks inline
 * page scripts. API requests use `GM_xmlhttpRequest` for the same reason.
 */

(function () {
  "use strict";

  const subscribedRepositories = {
    "NixOS/nixpkgs": [
      "master",
      "nixos-unstable-small",
      "nixos-unstable",
      "nixpkgs-unstable",
      "staging-next",
    ],
  };

  const pullRequestPattern = /^\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
  const headerSelector = '[class*="PageHeader-Description"], .gh-header-meta';
  const markerAttribute = "data-nixpkgs-branch-tracker";
  const tokenStorageKey = "github_api_token";

  GM_registerMenuCommand("Set GitHub token", () => {
    const token = prompt(
      "Enter a GitHub Personal Access Token to avoid rate limits.\n" +
        "Use a classic token with no scopes, or a fine-grained token with\n" +
        "public repository read-only access. Do not grant write scopes.\n" +
        "Leave empty to remove the stored token.",
      GM_getValue(tokenStorageKey, ""),
    );
    if (token !== null) {
      GM_setValue(tokenStorageKey, token.trim());
      // Remove failed or stale renders so update() retries with the new token.
      document
        .querySelectorAll(`[${markerAttribute}]`)
        .forEach((element) => element.remove());
      update();
    }
  });

  /**
   * Normalizes the repository name with a case-insensitive comparison against
   * the subscribed repositories.
   */
  const normalizeRepositoryName = (repository) =>
    Object.keys(subscribedRepositories).find(
      (name) =>
        name.localeCompare(repository, undefined, { sensitivity: "accent" }) ===
        0,
    ) ?? repository;

  const requestJson = (url) =>
    new Promise((resolve, reject) => {
      const token = GM_getValue(tokenStorageKey, "");
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: {
          Accept: "application/vnd.github+json",
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        onload: (response) => {
          if (response.status === 200) {
            resolve(JSON.parse(response.responseText));
            return;
          }
          const reset = response.responseHeaders.match(
            /^x-ratelimit-reset:\s*(\d+)/im,
          );
          const rateLimited =
            [403, 429].includes(response.status) &&
            /^x-ratelimit-remaining:\s*0\s*$/im.test(response.responseHeaders);
          reject(
            new Error(
              rateLimited
                ? `GitHub API rate limit reached until ${new Date(reset[1] * 1000).toLocaleTimeString()}. ` +
                  'Set a token in the Tampermonkey menu: "Set GitHub token".'
                : `HTTP ${response.status} for ${url}`,
            ),
          );
        },
        onerror: (response) =>
          reject(
            new Error(
              `Request failed for ${url}: ${response?.error || response?.statusText || "blocked"}`,
            ),
          ),
      });
    });

  const createLink = (href, text, bold = false) => {
    const link = document.createElement("a");
    link.href = href;
    const label = document.createElement(bold ? "b" : "code");
    label.textContent = text;
    link.append(label);
    return link;
  };

  const render = async (header, repository, pullRequestNumber) => {
    const container = document.createElement("div");
    container.setAttribute(
      markerAttribute,
      `${repository}#${pullRequestNumber}`,
    );
    container.className = "d-flex flex-wrap flex-items-center gap-2 mt-1";
    const status = document.createElement("span");
    status.className = "color-fg-muted";
    status.textContent = "🔏 Loading…";
    container.append(status);
    header.append(container);

    let pullRequest;
    try {
      pullRequest = await requestJson(
        `https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}`,
      );
    } catch (error) {
      status.textContent = `⚠️ Nixpkgs PR Branch Tracker: ${error.message}`;
      throw error;
    }
    status.remove();

    // GitHub provides merge_commit_sha even for unmerged PRs. It is the test
    // merge commit, which is useful for testing the PR before it is merged.
    const commitHash = pullRequest.merge_commit_sha;
    if (!commitHash) {
      return;
    }

    container.append(
      "🔏",
      createLink(
        `https://github.com/${repository}/commit/${commitHash}`,
        commitHash.slice(0, 7),
      ),
    );

    const branches = subscribedRepositories[repository];
    if (!pullRequest.merged || !branches) {
      return;
    }

    const compareLink = `https://github.com/${repository}/compare`;
    const compareApi = `https://api.github.com/repos/${repository}/compare/${commitHash}`;

    for (const branch of branches) {
      const link = createLink(
        `${compareLink}/${commitHash}...${branch}`,
        branch,
        true,
      );
      container.append(link);

      // A commit never leaves a branch, so cache positive results to save
      // API requests.
      const cacheKey = `merged:${repository}:${commitHash}:${branch}`;
      const status = GM_getValue(cacheKey, false)
        ? Promise.resolve(true)
        : // A page number past the end returns the comparison status without
          // the commit list and file differences.
          requestJson(`${compareApi}...${branch}?per_page=100&page=100`).then(
            ({ status }) => {
              const merged = status === "ahead" || status === "identical";
              if (merged) {
                GM_setValue(cacheKey, true);
              }
              return merged;
            },
          );
      status
        .then((merged) => {
          if (!merged) {
            // Reverse the comparison to show how far behind the branch is.
            link.href = `${compareLink}/${branch}...${commitHash}`;
          }
          link.prepend(merged ? "✅ " : "⚠️ ");
        })
        .catch((error) => {
          link.prepend("❓ ");
          link.title = error.message;
          console.error(error);
        });
    }
  };

  /**
   * GitHub renders pull request pages with React and soft navigation, so the
   * header can appear or be replaced after the initial page load.
   */
  const update = () => {
    const match = location.pathname.match(pullRequestPattern);
    if (!match) {
      return;
    }
    const repository = normalizeRepositoryName(match[1]);
    const pullRequestNumber = match[2];
    const header = document.querySelector(headerSelector);
    if (
      !header ||
      header.querySelector(
        `[${markerAttribute}="${repository}#${pullRequestNumber}"]`,
      )
    ) {
      return;
    }
    header.querySelector(`[${markerAttribute}]`)?.remove();
    render(header, repository, pullRequestNumber).catch((error) =>
      console.error(error),
    );
  };

  // Poll instead of using MutationObserver. In Firefox, a sandboxed observer
  // on page nodes causes "Permission denied to access property" errors.
  setInterval(update, 500);
  update();
})();
