const BASE = "http://127.0.0.1:8000";

export interface SearchResult {
  file_path: string;
  page_number: number;
  text_snippet: string;
  similarity_score: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export interface IndexResponse {
  status: string;
  total_pages: number;
  total_files: number;
  files: string[];
  message?: string;
}

export interface BrowseFolderResponse {
  status: string;
  folder_path: string | null;
  message?: string;
}

export async function browseFolder(): Promise<BrowseFolderResponse> {
  const res = await fetch(`${BASE}/browse-folder`);
  if (!res.ok) {
    throw new Error("Failed to open folder picker");
  }
  return res.json();
}

export async function indexFolder(folderPath: string): Promise<IndexResponse> {
  const res = await fetch(`${BASE}/index`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder_path: folderPath }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Indexing failed");
  }
  return res.json();
}

export async function searchSlides(
  query: string,
  nResults = 10
): Promise<SearchResponse> {
  const res = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, n_results: nResults }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Search failed");
  }
  return res.json();
}

export function getPdfUrl(filePath: string, page?: number): string {
  // Encode each path segment individually to preserve '/' for subfolder paths
  const encoded = filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const url = `${BASE}/pdf/${encoded}`;
  return page ? `${url}#page=${page}` : url;
}
