import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "fixtures.json");
const baseUrl = (process.env.BILLORA_TEST_BASE_URL || "http://localhost:3001").replace(/\\/+$/, "");
const token = process.env.BILLORA_TEST_TOKEN;
const workerToken = process.env.BILLORA_WORKER_TOKEN;

if (!token || token.length < 32) {
  throw new Error("Set BILLORA_TEST_TOKEN (at least 32 characters) before running this test.");
}
if (!workerToken) {
  throw new Error("Set BILLORA_WORKER_TOKEN to the same secret as WORKER_SECRET. The test must be able to trigger the real worker.");
}
if (!fs.existsSync(manifestPath)) throw new Error("fixtures.json is missing.");

const fixtures = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\\uFEFF/, ""));
if (!Array.isArray(fixtures) || fixtures.length !== 5) {
  throw new Error(`Expected exactly 5 fixtures; found ${fixtures?.length ?? 0}.`);
}
for (const fixture of fixtures) {
  if (!fixture.FullName || !fs.existsSync(fixture.FullName)) {
    throw new Error(`Fixture missing: ${fixture.FullName || fixture.Name}`);
  }
}

const correlationId = crypto.randomUUID();
const headers = { "x-billora-test-token": token };

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`${options.method || "GET"} ${url} returned non-JSON HTTP ${response.status}: ${raw.slice(0, 500)}`); }
  if (!response.ok) {
    const code = body?.error?.code || body?.status || "REQUEST_FAILED";
    throw new Error(`${options.method || "GET"} ${url}: HTTP ${response.status} (${code})${body.existingInvoiceId ? `; existing invoice ${body.existingInvoiceId} (${body.existingInvoiceStatus})` : ""}`);
  }
  return body;
}

async function uploadOne(fixture) {
  const bytes = fs.readFileSync(fixture.FullName);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), fixture.Name);
  form.append("batchId", correlationId);

  const result = await jsonRequest(`${baseUrl}/api/testing/invoices/upload`, {
    method: "POST",
    headers,
    body: form,
  });
  if (!result.ok || !result.invoiceId || !result.jobId) {
    throw new Error(`Unexpected upload response for ${fixture.Name}`);
  }
  console.log(`ACCEPTED ${fixture.Name} -> invoice=${result.invoiceId}, job=${result.jobId}`);
  return { fixture: fixture.Name, invoiceId: result.invoiceId, jobId: result.jobId };
}

async function runWorkerTick() {
  const response = await fetch(`${baseUrl}/api/jobs/worker`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-token": workerToken,
    },
    body: JSON.stringify({ limit: 5 }),
  });
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error(`Worker returned non-JSON HTTP ${response.status}: ${raw.slice(0, 500)}`); }
  if (!response.ok || !result.ok) {
    throw new Error(`Worker tick failed: HTTP ${response.status} (${result.status || "WORKER_FAILED"})`);
  }
  console.log(`WORKER claimed=${result.claimed ?? 0} completed=${result.completed ?? 0} failed=${result.failed ?? 0} requeued=${result.requeued ?? 0}`);
}

async function readStatus(invoiceIds) {
  return jsonRequest(`${baseUrl}/api/testing/invoices/status`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ invoiceIds }),
  });
}

async function main() {
  console.log("Billora five-invoice end-to-end staging test");
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Correlation ID: ${correlationId}`);
  console.log("Uploading five fixtures concurrently; no invoice is auto-approved.");

  const uploads = await Promise.all(fixtures.map(uploadOne));
  const invoiceIds = uploads.map((item) => item.invoiceId);
  if (new Set(invoiceIds).size !== 5) {
    throw new Error("The five uploads did not produce five distinct invoice IDs. Stop and inspect duplicate handling.");
  }

  const deadline = Date.now() + 15 * 60 * 1000;
  let status;
  while (Date.now() < deadline) {
    await runWorkerTick();
    status = await readStatus(invoiceIds);
    if (status.total !== 5 || !Array.isArray(status.invoices)) {
      throw new Error(`Expected status for exactly five invoice IDs; received ${status.total ?? "unknown"}.`);
    }
    console.log("STATUS", JSON.stringify({
      pending: status.pending,
      processing: status.processing,
      failed: status.failed,
      reviewRequired: status.reviewRequired,
      invoices: status.invoices.map((row) => ({
        invoiceId: row.invoiceId,
        invoiceStatus: row.invoiceStatus,
        jobStatus: row.jobStatus,
        reviewStatus: row.reviewStatus,
        errorCode: row.errorCode,
      })),
    }));

    if (status.pending === 0 && status.processing === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (!status || status.pending > 0 || status.processing > 0) {
    throw new Error("Timed out waiting for all five extraction jobs. Check worker and function logs.");
  }
  if (status.failed > 0) {
    throw new Error(`${status.failed} invoice job(s) failed. Inspect safe error codes in the status output.`);
  }

  const outputDir = path.resolve(here, "../../test-results");
  fs.mkdirSync(outputDir, { recursive: true });
  const report = {
    createdAt: new Date().toISOString(),
    baseUrl,
    correlationId,
    uploads,
    status,
    note: "Invoices requiring review have NOT been approved. Open the app as a signed-in workspace member, review them normally, then use the downloadPath values below to download each ready workbook.",
  };
  const outputPath = path.join(outputDir, `billora-five-file-${correlationId}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log("\\nEXTRACTION COMPLETE");
  console.log(`Uploaded: ${uploads.length}/5`);
  console.log(`Review required: ${status.reviewRequired}`);
  console.log(`Workbook manifest: ${outputPath}`);

  if (!status.workbooks?.length) {
    console.log("No ready workbooks yet. This is expected when invoices still require human review.");
  } else {
    console.log("Ready workbooks (download only while signed into the matching workspace):");
    for (const workbook of status.workbooks) {
      console.log(`- ${workbook.periodStart || "period pending"} | ${workbook.category || "uncategorized"} | ${baseUrl}${workbook.downloadPath}`);
    }
  }
  console.log("NEXT: manually inspect extracted fields, approve/correct through the normal review UI, then download the resulting workbooks.");
}

main().catch((error) => {
  console.error("\\nTEST FAILED");
  console.error(error);
  process.exitCode = 1;
});
