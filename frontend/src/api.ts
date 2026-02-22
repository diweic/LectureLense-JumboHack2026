const BASE = "http://127.0.0.1:8000";

export interface SearchResult {
  file_path: string;
  page_number: number;
  text_snippet: string;
  full_text: string;
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
  nResults = 10,
  rerank = false
): Promise<SearchResponse> {
  const res = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, n_results: nResults, rerank }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Search failed");
  }
  return res.json();
}

export interface SummarizeResponse {
  summary: string;
}

export async function summarize(
  query: string,
  text: string
): Promise<SummarizeResponse> {
  const res = await fetch(`${BASE}/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, text }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Summary failed");
  }
  return res.json();
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatSource {
  file_path: string;
  page_number: number;
}

export interface ChatResponse {
  answer: string;
  sources: ChatSource[];
}

export async function chatWithSlides(
  question: string,
  history: ChatMessage[] = []
): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Chat failed");
  }
  return res.json();
}

export function getPageImageUrl(filePath: string, page: number): string {
  const encoded = filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${BASE}/page-image/${encoded}?page=${page}`;
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

export function getFileUrl(filePath: string): string {
  const encoded = filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${BASE}/file/${encoded}`;
}

export function isPdf(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}
