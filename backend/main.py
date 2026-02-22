"""
FastAPI backend for the Slide Search Tool.

Routes:
  GET  /browse-folder — open native OS folder picker dialog
  POST /index   — index a folder of PDFs
  POST /search  — semantic search across indexed slides
  GET  /pdf/{path} — serve a PDF file for viewing
"""

import os
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

import chromadb
import ollama

from indexer import index_folder, CHROMA_DIR, COLLECTION_NAME, EMBED_MODEL

app = FastAPI(title="Slide Search")

# CORS — restricted to localhost only
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Request / Response models ──────────────────────────────────────

class IndexRequest(BaseModel):
    folder_path: str

class SearchRequest(BaseModel):
    query: str
    n_results: int = 10

class SearchResult(BaseModel):
    file_path: str
    page_number: int
    text_snippet: str
    similarity_score: float

class IndexResponse(BaseModel):
    status: str
    total_pages: int
    total_files: int
    files: list[str]
    message: str | None = None

class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]

# ── Helpers ────────────────────────────────────────────────────────

def _get_root_folder() -> str | None:
    """Retrieve the root folder path stored during indexing."""
    try:
        client = chromadb.PersistentClient(path=CHROMA_DIR)
        collection = client.get_collection(COLLECTION_NAME)
        result = collection.get(ids=["__root__"])
        if result["metadatas"]:
            return result["metadatas"][0].get("root_folder")
    except Exception:
        pass
    return None

# ── Routes ─────────────────────────────────────────────────────────

@app.get("/browse-folder")
def api_browse_folder():
    """Open a native OS folder picker dialog and return the selected path."""
    try:
        if sys.platform == "darwin":
            # macOS: AppleScript Finder dialog
            result = subprocess.run(
                ["osascript", "-e",
                 'POSIX path of (choose folder with prompt "Select a folder of slides")'],
                capture_output=True, text=True, timeout=120,
            )
        elif sys.platform == "win32":
            # Windows: PowerShell folder browser dialog
            ps_script = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
                "$d.Description = 'Select a folder of slides'; "
                "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }"
            )
            result = subprocess.run(
                ["powershell", "-Command", ps_script],
                capture_output=True, text=True, timeout=120,
            )
        else:
            # Linux: zenity folder selection
            result = subprocess.run(
                ["zenity", "--file-selection", "--directory",
                 "--title=Select a folder of slides"],
                capture_output=True, text=True, timeout=120,
            )

        if result.returncode != 0:
            return {"status": "cancelled", "folder_path": None}

        folder = result.stdout.strip().rstrip("/").rstrip("\\")
        return {"status": "ok", "folder_path": folder}

    except subprocess.TimeoutExpired:
        return {"status": "cancelled", "folder_path": None}
    except FileNotFoundError:
        # Dialog tool not found (e.g. zenity not installed on Linux)
        return {"status": "error", "folder_path": None,
                "message": "Folder picker not available on this system. Please type the path manually."}


@app.post("/index", response_model=IndexResponse)
def api_index(req: IndexRequest):
    folder = req.folder_path.strip()
    if not os.path.isdir(folder):
        raise HTTPException(status_code=400, detail=f"Folder not found: {folder}")

    result = index_folder(folder)

    if result["status"] == "error":
        raise HTTPException(status_code=400, detail=result.get("message", "Indexing failed"))

    return IndexResponse(
        status=result["status"],
        total_pages=result["total_pages"],
        total_files=result["total_files"],
        files=result["files"],
    )


@app.post("/search", response_model=SearchResponse)
def api_search(req: SearchRequest):
    query = req.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    try:
        client = chromadb.PersistentClient(path=CHROMA_DIR)
        collection = client.get_collection(COLLECTION_NAME)
    except Exception:
        raise HTTPException(status_code=400, detail="No index found. Please index a folder first.")

    # Generate query embedding
    query_embedding = ollama.embed(model=EMBED_MODEL, input=query).embeddings[0]

    # Search ChromaDB
    raw = collection.query(
        query_embeddings=[query_embedding],
        n_results=req.n_results + 1,  # +1 to account for __root__ marker
        where={"file_path": {"$ne": "__root__"}},
    )

    results = []
    for i in range(len(raw["ids"][0])):
        meta = raw["metadatas"][0][i]
        distance = raw["distances"][0][i]
        text = raw["documents"][0][i]

        # Convert cosine distance to similarity score (0-1, higher is better)
        similarity = 1 - distance

        # Take first ~200 chars as snippet, clean up whitespace
        snippet = " ".join(text[:300].split())
        if len(text) > 300:
            snippet += "..."

        results.append(SearchResult(
            file_path=meta["file_path"],
            page_number=meta["page_number"],
            text_snippet=snippet,
            similarity_score=round(similarity, 4),
        ))

    # Limit to requested count (in case __root__ filter didn't reduce)
    results = results[:req.n_results]

    return SearchResponse(query=query, results=results)


@app.get("/pdf/{file_path:path}")
def api_serve_pdf(file_path: str):
    """Serve a PDF file from the indexed folder."""
    root = _get_root_folder()
    if not root:
        raise HTTPException(status_code=400, detail="No indexed folder found")

    full_path = Path(root) / file_path
    if not full_path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    if not full_path.suffix.lower() == ".pdf":
        raise HTTPException(status_code=400, detail="Only PDF files can be served")

    return FileResponse(
        path=str(full_path),
        media_type="application/pdf",
        filename=full_path.name,
        content_disposition_type="inline",
    )
