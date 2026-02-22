# LectureLens

## Run Locally

### Prerequisites

Ollama must be running with these models pulled:

```bash
ollama pull nomic-embed-text
ollama pull qwen3:1.7b
```

### Backend

```bash
cd backend
source venv/bin/activate
uvicorn main:app --reload
```

Runs on http://127.0.0.1:8000

### Frontend

```bash
cd frontend
npm run dev
```

Runs on http://localhost:5173

### Stop

Ctrl+C in each terminal. Deactivate the venv with:

```bash
deactivate
```
