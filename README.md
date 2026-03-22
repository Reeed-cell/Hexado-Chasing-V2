# 🌪️ Hexado Chasing V2

A high-performance, browser-based 3D tornado-chasing simulation built with **Three.js (r128)** and **Vanilla JavaScript**. 

This project is currently in **active development** and is being built as a private technical challenge. [cite_start]It utilizes a specialized 14-module architecture designed for procedural generation, realistic weather scaling, and strict memory management. [cite: 1]

---

## 🚀 Project Status

* **Status:** Work-in-Progress (Alpha).
* [cite_start]**Architecture:** 14-module decoupled system using a global `EventBus`. [cite: 1]
* **Assets:** 100% procedural. [cite_start]No external models or textures are used; everything is generated via code. [cite: 1]

---

## 🛠️ Internal Architecture

[cite_start]To maintain the "Single Source of Truth" for physics and rendering, the engine follows a strict load order: [cite: 1]

1.  **Foundation:** `eventbus.js`, `main-math.js`, `3DEngine.js`
2.  **Systems:** `physics.js`, `weather.js`, `tornado.js`, `Characters.js`
3.  **World & Rendering:** `terrain.js`, `environment.js`, `Render.js`
4.  **UI & Optimization:** `HUD.js`, `performance-optimizer.js`
5.  **Orchestration:** `main.js`

---

## 🎮 Features & Mechanics

* [cite_start]**Weather State Machine:** Dynamic cycles: Clear (30-80s) → Forming (20-35s) → Active (40-130s) → Dissipating (12-24s). [cite: 1]
* [cite_start]**Terrain Snap:** All entities use `HE.TerrainGen.heightAt(x, z)` to calculate ground Y-position. [cite: 1]
* [cite_start]**Dual-Mode:** Support for First-Person Vehicle driving and Third-Person walking (E key). [cite: 1]

---

## 📜 License & Usage

**Copyright (c) 2026 Reeed-cell. All rights reserved.**

This source code is provided for **educational and portfolio viewing purposes only**. 
* **No Redistribution:** You may not redistribute, sub-license, or sell this code.
* **No Derivation:** You may not use this code as a base for your own commercial projects without explicit permission.
* **Attribution:** If you reference the architecture or snippets for educational purposes, please provide clear attribution to this repository.

---

## 🤝 Contributions

At this time, this is a solo project. I am not looking for contributors or pull requests. Please do not fork this repository with the intent of re-uploading it as your own work.
