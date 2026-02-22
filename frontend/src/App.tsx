import { useState, useRef, useEffect, useCallback } from "react";
import { browseFolder, indexFolder, searchSlides, summarize, getPdfUrl, getPageImageUrl, getFileUrl, isPdf } from "./api";
import type { SearchResult, IndexResponse } from "./api";
import ChatView from "./ChatView";
import "./App.css";

// ── Helpers ───────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had", "in", "on", "at", "to",
  "for", "of", "with", "by", "from", "it", "its", "this", "that",
  "what", "which", "who", "how", "when", "where", "why", "and", "or",
  "not", "no", "but", "if", "so", "as", "can", "will", "my", "me",
]);

/** Highlight query words in a text snippet. Returns React elements. */
function highlightSnippet(text: string, query: string): React.ReactNode[] {
  const queryWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  if (queryWords.length === 0) return [text];

  // Build regex that matches any query word (word boundaries, case-insensitive)
  const pattern = new RegExp(
    `(${queryWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi"
  );

  const parts = text.split(pattern);
  return parts.map((part, i) => {
    if (queryWords.includes(part.toLowerCase())) {
      return <mark key={i}>{part}</mark>;
    }
    return part;
  });
}

/** Group results by file_path, ordered by best score in each group. */
interface ResultGroup {
  filePath: string;
  bestScore: number;
  results: SearchResult[];
}

function groupResults(results: SearchResult[]): ResultGroup[] {
  const map = new Map<string, SearchResult[]>();
  for (const r of results) {
    const arr = map.get(r.file_path) || [];
    arr.push(r);
    map.set(r.file_path, arr);
  }

  const groups: ResultGroup[] = [];
  for (const [filePath, items] of map) {
    groups.push({
      filePath,
      bestScore: Math.max(...items.map((r) => r.similarity_score)),
      results: items,
    });
  }

  // Sort groups by best score descending
  groups.sort((a, b) => b.bestScore - a.bestScore);
  return groups;
}

// ── App Component ─────────────────────────────────────────────────

type Tab = "search" | "chat";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("search");
  const [dark, setDark] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }, [dark]);

  // Indexing state
  const [folderPath, setFolderPath] = useState("");
  const [indexInfo, setIndexInfo] = useState<IndexResponse | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexError, setIndexError] = useState("");
  const [browsing, setBrowsing] = useState(false);

  // Search state
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [rerank, setRerank] = useState(false);

  // Slide preview modal state
  const [previewImage, setPreviewImage] = useState<{ url: string; label: string } | null>(null);

  // Summary state
  const [showSummaries, setShowSummaries] = useState(false);
  // key: "file_path::page_number", value: summary text or null (loading)
  const [summaries, setSummaries] = useState<Record<string, string | null>>({});
  const summaryAbortRef = useRef(false);

  // Fetch summaries one at a time when toggled on
  const fetchSummaries = useCallback(
    async (query: string, items: SearchResult[]) => {
      summaryAbortRef.current = false;
      const fetched = new Set<string>();
      // Snapshot which keys are already done
      setSummaries((prev) => {
        for (const k of Object.keys(prev)) {
          if (prev[k] !== null) fetched.add(k);
        }
        return prev;
      });

      for (const r of items) {
        if (summaryAbortRef.current) break;
        const key = `${r.file_path}::${r.page_number}`;
        if (fetched.has(key)) continue;

        setSummaries((prev) => ({ ...prev, [key]: null })); // null = loading
        try {
          const res = await summarize(query, r.full_text);
          if (summaryAbortRef.current) break;
          setSummaries((prev) => ({ ...prev, [key]: res.summary }));
        } catch {
          if (summaryAbortRef.current) break;
          setSummaries((prev) => ({ ...prev, [key]: "Summary unavailable." }));
        }
      }
    },
    []
  );

  useEffect(() => {
    if (showSummaries && results.length > 0 && lastQuery) {
      fetchSummaries(lastQuery, results);
    }
    return () => {
      summaryAbortRef.current = true;
    };
  }, [showSummaries, results, lastQuery, fetchSummaries]);

  const handleIndex = async () => {
    if (!folderPath.trim()) return;
    setIndexing(true);
    setIndexError("");
    setIndexInfo(null);
    try {
      const info = await indexFolder(folderPath.trim());
      setIndexInfo(info);
    } catch (e) {
      setIndexError(e instanceof Error ? e.message : "Indexing failed");
    } finally {
      setIndexing(false);
    }
  };

  const handleBrowse = async () => {
    setBrowsing(true);
    setIndexError("");
    try {
      const res = await browseFolder();
      if (res.status === "ok" && res.folder_path) {
        setFolderPath(res.folder_path);
      } else if (res.status === "error" && res.message) {
        setIndexError(res.message);
      }
    } catch (e) {
      setIndexError(e instanceof Error ? e.message : "Could not open folder picker");
    } finally {
      setBrowsing(false);
    }
  };

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) return;
    summaryAbortRef.current = true;
    setSearching(true);
    setSearchError("");
    setSummaries({});
    try {
      const res = await searchSlides(q, 10, rerank);
      setResults(res.results);
      setLastQuery(q);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  const handleIndexKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleIndex();
  };

  const handleNewSearch = () => {
    summaryAbortRef.current = true;
    setQuery("");
    setResults([]);
    setLastQuery("");
    setSearchError("");
    setSummaries({});
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const handleChangeFolder = () => {
    summaryAbortRef.current = true;
    setFolderPath("");
    setIndexInfo(null);
    setIndexError("");
    setQuery("");
    setResults([]);
    setLastQuery("");
    setSearchError("");
    setSummaries({});
  };

  // Derived data
  const groups = results.length > 0 ? groupResults(results) : [];
  const sourceFiles = groups.map((g) => g.filePath);

  return (
    <div className="app">
      <header className="header">
        <div className="header-row">
          <h1>LectureLens</h1>
          <button className="btn btn-theme" onClick={() => setDark((d) => !d)}>
            {dark ? "Light" : "Dark"}
          </button>
        </div>
        <p className="subtitle">
          AI-powered search across your lecture slides
        </p>
        <nav className="tab-bar">
          <button
            className={`tab ${activeTab === "search" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("search")}
          >
            Search
          </button>
          <button
            className={`tab ${activeTab === "chat" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            Chat
          </button>
        </nav>
      </header>

      {/* Index Section */}
      <section className="index-section">
        <div className="input-row">
          <input
            type="text"
            className="folder-input"
            placeholder="Click Browse or paste a folder path"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            onKeyDown={handleIndexKeyDown}
            disabled={indexing || browsing}
          />
          <button
            className="btn btn-browse"
            onClick={handleBrowse}
            disabled={indexing || browsing}
          >
            {browsing ? "Opening..." : "Browse"}
          </button>
          <button
            className="btn btn-index"
            onClick={handleIndex}
            disabled={indexing || browsing || !folderPath.trim()}
          >
            {indexing ? "Confirming..." : "Confirm Folder"}
          </button>
        </div>

        {indexError && <p className="error">{indexError}</p>}

        {/* Indexing spinner */}
        {indexing && (
          <div className="indexing-status">
            <div className="spinner" />
            <span>Indexing your slides... This may take a moment.</span>
          </div>
        )}

        {indexInfo && (
          <div className="index-info">
            Indexed <strong>{indexInfo.total_pages}</strong> pages across{" "}
            <strong>{indexInfo.total_files}</strong> files
            {indexInfo.message && (
              <span className="index-cache-note"> — {indexInfo.message}</span>
            )}
          </div>
        )}
      </section>

      {activeTab === "search" && <>
      {/* Search Section */}
      <section className="search-section">
        <p className="search-hint">
          Tip: Try asking a complete question for more accurate results
        </p>
        <div className="input-row">
          <input
            ref={searchInputRef}
            type="text"
            className="search-input"
            placeholder="Ask about a concept (e.g. What is decidability?)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            disabled={searching}
          />
          <button
            className="btn btn-search"
            onClick={handleSearch}
            disabled={searching || !query.trim()}
          >
            {searching ? (rerank ? "Re-ranking with AI..." : "Searching...") : "Search"}
          </button>
        </div>
        <label className="rerank-toggle">
          <input
            type="checkbox"
            checked={rerank}
            onChange={(e) => setRerank(e.target.checked)}
            disabled={searching}
          />
          AI Re-ranking
          <span className="rerank-hint">(slower, better relevance)</span>
        </label>
        {searchError && <p className="error">{searchError}</p>}
      </section>

      {/* Results */}
      {groups.length > 0 && (
        <section className="results-section">
          <div className="results-toolbar">
            <h2 className="results-heading">
              Results for &ldquo;{lastQuery}&rdquo;
            </h2>
            <div className="results-actions">
              <button
                className={`btn btn-toggle ${showSummaries ? "btn-toggle-on" : ""}`}
                onClick={() => setShowSummaries((v) => !v)}
              >
                {showSummaries ? "AI Summaries On" : "AI Summaries Off"}
              </button>
              <button className="btn btn-secondary" onClick={handleNewSearch}>
                New Search
              </button>
              <button className="btn btn-secondary" onClick={handleChangeFolder}>
                Change Folder
              </button>
            </div>
          </div>

          {/* Source summary — one file per line */}
          <div className="source-summary">
            <div className="source-summary-title">
              Found in {sourceFiles.length} file{sourceFiles.length !== 1 ? "s" : ""}:
            </div>
            {sourceFiles.map((f) => (
              <div key={f} className="source-file-item">
                {f}
              </div>
            ))}
          </div>

          {/* Grouped results */}
          <div className="results-list">
            {groups.map((group) => (
              <div key={group.filePath} className="result-group">
                <div className="result-group-header">
                  <span className="result-group-file">{group.filePath}</span>
                  <span className="result-group-count">
                    {group.results.length} page{group.results.length !== 1 ? "s" : ""}
                  </span>
                  <a
                    className="btn btn-open"
                    href={isPdf(group.filePath) ? getPdfUrl(group.filePath) : getFileUrl(group.filePath)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {isPdf(group.filePath) ? "Open PDF" : "Open File"}
                  </a>
                </div>
                {group.results.map((r) => (
                  <div
                    key={`${r.file_path}-${r.page_number}`}
                    className="result-subcard"
                  >
                    <div className="result-header">
                      <span className="result-page">
                        {isPdf(r.file_path) ? `Page ${r.page_number}` : `Page ${r.page_number}`}
                      </span>
                      <span className="result-score">
                        {(r.similarity_score * 100).toFixed(1)}% match
                      </span>
                      {isPdf(r.file_path) ? (
                        <a
                          className="btn btn-open-small"
                          href={getPdfUrl(r.file_path, r.page_number)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Go to page
                        </a>
                      ) : (
                        <a
                          className="btn btn-open-small"
                          href={getFileUrl(r.file_path)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open file
                        </a>
                      )}
                    </div>
                    {isPdf(r.file_path) ? (
                      <img
                        className="result-thumbnail"
                        src={getPageImageUrl(r.file_path, r.page_number)}
                        alt={`${r.file_path} page ${r.page_number}`}
                        loading="lazy"
                        onClick={() =>
                          setPreviewImage({
                            url: getPageImageUrl(r.file_path, r.page_number),
                            label: `${r.file_path} — Page ${r.page_number}`,
                          })
                        }
                      />
                    ) : (
                      <div className="result-text-preview">
                        {r.full_text.slice(0, 500)}
                        {r.full_text.length > 500 && "..."}
                      </div>
                    )}
                    <p className="result-snippet">
                      {highlightSnippet(r.text_snippet, lastQuery)}
                    </p>
                    {showSummaries && (() => {
                      const key = `${r.file_path}::${r.page_number}`;
                      const summary = summaries[key];
                      if (summary === undefined) {
                        // Hasn't started yet (queued)
                        return (
                          <div className="result-summary result-summary-loading">
                            <span className="spinner spinner-small" /> Waiting...
                          </div>
                        );
                      }
                      if (summary === null) {
                        return (
                          <div className="result-summary result-summary-loading">
                            <span className="spinner spinner-small" /> Generating summary...
                          </div>
                        );
                      }
                      return (
                        <div className="result-summary result-summary-ready">
                          <strong>AI:</strong> {summary}
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      {lastQuery && results.length === 0 && !searching && (
        <p className="no-results">No results found for &ldquo;{lastQuery}&rdquo;</p>
      )}
      </>}

      {activeTab === "chat" && <ChatView />}

      {/* Slide preview modal */}
      {previewImage && (
        <div className="modal-overlay" onClick={() => setPreviewImage(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-label">{previewImage.label}</span>
              <button className="btn modal-close" onClick={() => setPreviewImage(null)}>
                Close
              </button>
            </div>
            <img
              className="modal-image"
              src={previewImage.url}
              alt={previewImage.label}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
