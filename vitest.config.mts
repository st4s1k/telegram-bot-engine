import { defineConfig } from "vitest/config";

// Оффлайн-юнит-тесты воркера (моки KV/fetch) — обычный Vitest в node-окружении.
// НЕ используем @cloudflare/vitest-pool-workers: нашему mock-based сьюту workerd не нужен,
// а с кириллическими именами тестов пул сыплет MF-Vitest-Source non-ASCII warnings и медленнее.
// Понадобятся настоящие интеграционные тесты в workerd — заведём отдельный pool-workers проект.
export default defineConfig({
  test: {
    include: ["tests/*.test.mjs"],
  },
});
