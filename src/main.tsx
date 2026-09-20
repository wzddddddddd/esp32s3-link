import React from "react";
import ReactDOM from "react-dom/client";
import CloudEntry from "./CloudEntry";
import "./styles.css";
import "./workflows.css";
import "./cloud.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CloudEntry />
  </React.StrictMode>,
);
