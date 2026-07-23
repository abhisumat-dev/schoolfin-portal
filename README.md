# 🏫 SchoolFin — Fee Command Center & Recovery Engine

> **An intelligent, full-stack fee management portal for educational institutions featuring client-side computer vision (OCR) cheque parsing, dynamic rule-based penalty engines, real-time UPI streaming, and an offline-first conflict resolution ledger.**

---

## 🌟 Key Features

* **📷 Computer Vision OCR Scanner:** Client-side OCR powered by Tesseract.js that parses physical bank cheques or receipts and auto-matches extracted fields against defaulter invoices with confidence scoring.
* **⚙️ Visual Fee & Penalty Builder:** Flexible conditional rule engine allowing administrators to build late-fee penalties and defaulter escalation workflows visually without writing code.
* **📱 Zero-Fee Reactive UPI Streaming:** Real-time UPI QR generation (`upi://pay`) bound to live database listeners for instant counter-top payment confirmation and celebratory feedback.
* **🔴 Offline-First Conflict Resolution Ledger:** Local-first IndexedDB queue that records transactions while offline and provides an interactive Sync Conflict Dashboard upon reconnection.
* **📊 Defaulter Risk Matrix & Analytics:** Dynamic risk scoring (`risk = 1.5 × days overdue + balance / 1000 + 6 × reminders ignored`) to prioritize recovery actions and instant WhatsApp payment triggers.

---

## 🛠️ Tech Stack

* **Frontend:** Vanilla JavaScript (ES6+), Glassmorphism CSS, Chart.js, QRCode.js, Tesseract.js, IndexedDB
* **Backend & Database:** Supabase (PostgreSQL, Realtime WebSockets, Row-Level Security, PL/pgSQL Triggers)
* **Automation:** TypeScript Firebase Cloud Functions (Late-Fee Cron Engine)

---

## 📁 Project Structure

```text
schoolfin-portal/
├── README.md                   # Project Documentation
├── index.html                  # Main Web Application & Dashboard
├── logo.jpeg                   # SchoolFin Brand Logo
├── .gitignore                  # Git Exclusion Rules
└── backend/                    # TypeScript Late-Fee Penalty Engine
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── lateFeeCron.ts
        ├── lateFeeCalculator.ts
        ├── reminderWorker.ts
        └── index.ts
