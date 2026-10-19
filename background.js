"use strict";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "go-to-last-page",
    title: "Go to last commits page",
    contexts: ["page", "link", "selection"],
    documentUrlPatterns: [
      "https://github.com/*/*/commits",
      "https://github.com/*/*/commits?*",
      "https://github.com/*/*/commits/*"
    ]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "go-to-last-page" || tab?.id == null || info.frameId) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: goToLastPage,
    args: [info.pageUrl]
  }).catch(error => console.error("Could not start the last-page search:", error));
});

async function goToLastPage(sourceURL) {
  if (location.href !== sourceURL || location.origin !== "https://github.com" ||
      !/^\/[^/]+\/[^/]+\/commits(?:\/|$)/.test(location.pathname)) return;
  if (document.getElementById("gh-last-page-progress")) return;

  function baseURL(value) {
    const url = new URL(value);
    for (const key of ["after", "before", "page"]) url.searchParams.delete(key);
    url.hash = "";
    return url;
  }

  function readPage(data) {
    const page = data?.payload?.commitsRefRoute;
    const pagination = page?.filters?.pagination;
    if (!Array.isArray(page?.commitGroups) || !pagination || page.timedOutMessage) {
      throw new Error("Could not retrieve the GitHub commit list.");
    }
    const commits = page.commitGroups.flatMap(group => group.commits);
    if (commits.some(commit => !commit?.oid) || typeof pagination.hasNextPage !== "boolean") {
      throw new Error("Could not recognize the GitHub response format.");
    }
    return { count: commits.length, ...pagination };
  }

  async function findLastPage(value, load, signal, progress = () => {}) {
    const base = baseURL(value);
    const get = async url => {
      signal?.throwIfAborted();
      const page = readPage(await load(url.href));
      signal?.throwIfAborted();
      progress();
      return page;
    };
    const first = await get(base);
    if (!first.hasNextPage) return base.href;
    const start = /^([a-f0-9]{40}) 0$/.exec(first.startCursor || "");
    const end = /^([a-f0-9]{40}) (\d+)$/.exec(first.endCursor || "");
    if (!start || !end || start[1] !== end[1] || Number(end[2]) !== first.count - 1 || !first.count) {
      throw new Error("This GitHub pagination format is not supported.");
    }
    const pageURL = index => {
      const url = new URL(base);
      url.searchParams.set("after", `${start[1]} ${index * first.count - 1}`);
      return url;
    };
    let low = 0;
    let high = 1;
    let expanding = true;
    // Bound requests even if the server stops honoring pagination.
    for (let requests = 0; requests < 48; requests++) {
      const index = expanding ? high : Math.floor((low + high) / 2);
      const url = pageURL(index);
      const page = await get(url);
      if (page.count) {
        const expected = `${start[1]} ${index * first.count}`;
        if (page.startCursor !== expected) throw new Error("GitHub pagination has changed.");
        if (!page.hasNextPage) return url.href;
        low = index;
        if (index === high) high *= 2;
      } else {
        high = index;
        expanding = false;
      }
      if (!expanding && high - low === 1) return low === 0 ? base.href : pageURL(low).href;
    }
    throw new Error("The search request limit was reached. Please try again later.");
  }

  function createProgressPanel(onCancel) {
    const panel = document.createElement("dialog");
    panel.id = "gh-last-page-progress";
    panel.style.cssText = "position:fixed;inset:16px 16px auto auto;margin:0;padding:16px;border:1px solid #888;border-radius:6px;z-index:2147483647;font:14px system-ui;";
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    status.textContent = "Finding the last page…";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.marginLeft = "12px";
    cancel.addEventListener("click", onCancel);
    panel.addEventListener("cancel", onCancel);
    panel.append(status, cancel);
    document.body.append(panel);
    panel.show();
    return { panel, status };
  }

  const controller = new AbortController();
  const { panel, status } = createProgressPanel(() => controller.abort());

  const watchNavigation = setInterval(() => {
    if (location.href !== sourceURL) controller.abort();
  }, 500);
  let requests = 0;
  try {
    const destination = await findLastPage(sourceURL, async url => {
      const response = await fetch(url, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      });
      if (!response.ok) throw new Error(`Could not fetch commits from GitHub (HTTP ${response.status}).`);
      return response.json();
    }, controller.signal, () => {
      status.textContent = `Finding the last page… (${++requests} pages checked)`;
    });
    if (location.href !== sourceURL) return;
    if (destination === location.href) alert("You are already on the last page.");
    else location.assign(destination);
  } catch (error) {
    if (!controller.signal.aborted && location.href === sourceURL) {
      alert(`${error.message} Choose “Go to last commits page” from the context menu to try again.`);
    }
  } finally {
    clearInterval(watchNavigation);
    panel.remove();
  }
}
