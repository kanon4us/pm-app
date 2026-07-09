"use strict";
(() => {
  // figma-plugin/src/figma-api.ts
  var FALLBACK_FONT = { family: "Inter", style: "Regular" };
  var APP_FONT = { family: "Montserrat", style: "Regular" };

  // figma-plugin/src/build-layout.ts
  var YIELD_EVERY = 20;
  var TEXT_SIZE = { heading: 20, body: 14, caption: 12 };
  async function buildLayout(api2, spec, hooks) {
    const summary = {
      pagesBuilt: 0,
      pagesArchived: 0,
      instancesPlaced: 0,
      placeholders: 0,
      framesBuilt: 0,
      fontSubstituted: false,
      aborted: false,
      failures: []
    };
    const targetNames = spec.pages.map((p) => p.name);
    const collisions = api2.pages.filter((p) => targetNames.includes(p.name));
    if (collisions.length > 0) {
      const ok = await hooks.confirmArchive(collisions.map((p) => p.name));
      if (!ok) {
        summary.aborted = true;
        return summary;
      }
      const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      for (const p of collisions) {
        p.name = `${p.name} (Archived ${stamp})`;
        summary.pagesArchived++;
      }
    }
    const importCache = /* @__PURE__ */ new Map();
    let sinceYield = 0;
    const maybeYield = async () => {
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        await hooks.onYield();
      }
    };
    const loadFont = async () => {
      try {
        await api2.loadFontAsync(APP_FONT);
        return APP_FONT;
      } catch {
        summary.fontSubstituted = true;
        await api2.loadFontAsync(FALLBACK_FONT);
        return FALLBACK_FONT;
      }
    };
    const importSet = async (key) => {
      if (importCache.has(key)) return importCache.get(key) ?? null;
      try {
        const set = await api2.importComponentSetByKeyAsync(key);
        importCache.set(key, set);
        return set;
      } catch (err) {
        importCache.set(key, null);
        summary.failures.push(`import ${key}: ${err instanceof Error ? err.message : "failed"}`);
        return null;
      }
    };
    const buildNode = async (node, parent) => {
      await maybeYield();
      switch (node.type) {
        case "instance": {
          const set = await importSet(node.componentKey);
          if (!set) {
            buildPlaceholder({ type: "placeholder", name: node.name ?? node.componentKey, note: "import failed" }, parent);
            return;
          }
          const inst = set.defaultVariant.createInstance();
          if (node.name) inst.name = node.name;
          if (node.variant && Object.keys(node.variant).length) {
            try {
              inst.setProperties(node.variant);
            } catch (e) {
              summary.failures.push(`variant ${node.componentKey}: ${e instanceof Error ? e.message : "failed"}`);
            }
          }
          parent.appendChild(inst);
          summary.instancesPlaced++;
          return;
        }
        case "frame": {
          const frame = api2.createFrame();
          frame.name = node.name ?? "Frame";
          frame.layoutMode = node.layout;
          frame.itemSpacing = node.spacing ?? 8;
          const pad = node.padding ?? 16;
          frame.paddingTop = frame.paddingRight = frame.paddingBottom = frame.paddingLeft = pad;
          frame.primaryAxisSizingMode = "AUTO";
          frame.counterAxisSizingMode = "AUTO";
          parent.appendChild(frame);
          summary.framesBuilt++;
          for (const child of node.children) await buildNode(child, frame);
          return;
        }
        case "text": {
          const font = await loadFont();
          const t = api2.createText();
          t.fontName = font;
          t.characters = node.characters;
          t.fontSize = TEXT_SIZE[node.style ?? "body"] ?? 14;
          parent.appendChild(t);
          return;
        }
        case "placeholder": {
          buildPlaceholder(node, parent);
          return;
        }
      }
    };
    const buildPlaceholder = (node, parent) => {
      const frame = api2.createFrame();
      frame.name = `\u2B1A ${node.name}${node.note ? ` \u2014 ${node.note}` : ""}`;
      frame.layoutMode = "VERTICAL";
      frame.paddingTop = frame.paddingRight = frame.paddingBottom = frame.paddingLeft = 16;
      frame.dashPattern = [4, 4];
      parent.appendChild(frame);
      summary.placeholders++;
    };
    for (const page of spec.pages) {
      const fpage = api2.createPage();
      fpage.name = page.name;
      for (const node of page.nodes) await buildNode(node, fpage);
      summary.pagesBuilt++;
    }
    return summary;
  }

  // figma-plugin/src/code.ts
  figma.showUI(__html__, { width: 340, height: 260 });
  var api = {
    get pages() {
      return figma.root.children;
    },
    createPage: () => figma.createPage(),
    createFrame: () => figma.createFrame(),
    createText: () => figma.createText(),
    importComponentSetByKeyAsync: (key) => figma.importComponentSetByKeyAsync(key),
    loadFontAsync: (font) => figma.loadFontAsync(font)
  };
  figma.ui.onmessage = async (msg) => {
    if (msg.type !== "publish") return;
    let parsed;
    try {
      parsed = JSON.parse(msg.payload ?? "");
      if (!parsed.featureId || !parsed.token || !parsed.baseUrl) throw new Error("missing fields");
    } catch {
      figma.ui.postMessage({ type: "error", message: "Invalid publish payload \u2014 re-copy it from pm-app." });
      return;
    }
    let spec;
    try {
      const res = await fetch(`${parsed.baseUrl}/api/features/${parsed.featureId}/figma-layout`, {
        headers: { Authorization: `Bearer ${parsed.token}` }
      });
      if (!res.ok) throw new Error(`layout fetch ${res.status}`);
      spec = await res.json();
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: `Could not fetch layout: ${e instanceof Error ? e.message : "error"}` });
      return;
    }
    const hooks = {
      confirmArchive: async (names) => {
        figma.ui.postMessage({ type: "confirm-archive", names });
        return await new Promise((resolve) => {
          const handler = (m) => {
            if (m.type === "confirm-archive-result") {
              figma.ui.off("message", handler);
              resolve(!!m.ok);
            }
          };
          figma.ui.on("message", handler);
        });
      },
      onYield: () => new Promise((r) => setTimeout(r, 0))
    };
    let summary;
    try {
      summary = await buildLayout(api, spec, hooks);
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: `Build failed: ${e instanceof Error ? e.message : "error"}` });
      return;
    }
    if (summary.aborted) {
      figma.notify("Publish cancelled \u2014 no changes made.");
      return;
    }
    const fileKey = figma.fileKey;
    if (fileKey) {
      try {
        await fetch(`${parsed.baseUrl}/api/features/${parsed.featureId}/figma-file`, {
          method: "POST",
          headers: { Authorization: `Bearer ${parsed.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fileKey })
        });
      } catch {
        summary.failures.push("writeback: could not POST figma-file");
      }
    } else {
      summary.failures.push("writeback skipped: figma.fileKey unavailable (save the file first)");
    }
    const parts = [
      `${summary.pagesBuilt} page(s)`,
      `${summary.instancesPlaced} instances`,
      summary.placeholders ? `${summary.placeholders} placeholder(s)` : "",
      summary.pagesArchived ? `${summary.pagesArchived} archived` : "",
      summary.fontSubstituted ? "font substituted (Inter)" : "",
      summary.failures.length ? `${summary.failures.length} issue(s)` : ""
    ].filter(Boolean);
    figma.notify(`Published: ${parts.join(" \xB7 ")}`);
    figma.ui.postMessage({ type: "done", summary });
  };
})();
