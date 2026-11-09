// The page asks the core over HTTP. React here; any framework works.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const api = (method = "GET") =>
  fetch("/api/hits", { method }).then((r) => r.json());

function App() {
  const [hits, setHits] = useState<number>();
  useEffect(() => void api().then(setHits), []);
  return (
    <>
      <h1>{hits ?? "…"}</h1>
      <button onClick={() => api("POST").then(setHits)}>Count</button>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
