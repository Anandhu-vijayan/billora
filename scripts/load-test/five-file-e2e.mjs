
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "fixtures.json");

const baseUrl = (process.env.BILLORA_TEST_BASE_URL || "http://localhost:3001")
  .replace(/\/+$/, "");

const token = process.env.BILLORA_TEST_TOKEN;

if (!token) {
  throw new Error("Set BILLORA_TEST_TOKEN before running this test.");
}

if (!fs.existsSync(manifestPath)) {
  throw new Error("fixtures.json is missing. Run the fixture discovery step first.");
}

const fixtures = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));

if (!Array.isArray(fixtures) || fixtures.length !== 5) {
  throw new Error(`Expected exactly 5 fixtures; found ${fixtures?.length ?? 0}.`);
}

for (const fixture of fixtures) {
  if (!fs.existsSync(fixture.FullName)) {
    throw new Error(`Fixture missing: ${fixture.FullName}`);
  }
}

const batchId = crypto.randomUUID();

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `${options.method || "GET"} ${url} failed: HTTP ${response.status}\n${body}`
    );
  }

  return { response, body };
}

async function uploadOne(fixture) {
  const bytes = fs.readFileSync(fixture.FullName);
  const form = new FormData();

  form.append(
    "file",
    new Blob([bytes], { type: "image/png" }),
    fixture.Name
  );
  form.append("batchId", batchId);

  const { body } = await request(`${baseUrl}/api/testing/invoices/upload`, {
    method: "POST",
    headers: {
      "x-billora-test-token": token
    },
    body: form
  });

  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error(`Upload returned non-JSON response for ${fixture.Name}: ${body}`);
  }

  if (!result.ok || !result.uploadId || !result.jobId) {
    throw new Error(`Unexpected upload response for ${fixture.Name}: ${body}`);
  }

  console.log(`ACCEPTED ${fixture.Name} -> upload=${result.uploadId}, job=${result.jobId}`);
  return result;
}

async function main() {
  console.log(`Billora five-file staging test`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Batch ID: ${batchId}`);

  // Upload all five files concurrently.
  const uploads = await Promise.all(fixtures.map(uploadOne));

  console.log(`\nAccepted ${uploads.length}/5 files.`);

  const deadline = Date.now() + 10 * 60 * 1000;
  let status;

  while (Date.now() < deadline) {
    const { body } = await request(
      `${baseUrl}/api/testing/invoices/status/${encodeURIComponent(batchId)}`,
      {
        headers: {
          "x-billora-test-token": token
        }
      }
    );

    status = JSON.parse(body);

    console.log("STATUS", JSON.stringify(status));

    if (!status.ok) {
      throw new Error(`Status endpoint reported failure: ${body}`);
    }

    if (status.total !== 5) {
      throw new Error(`Expected 5 records in batch; got ${status.total}`);
    }

    if (status.pending === 0 && status.processing === 0) {
      break;
    }

    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  if (!status || status.pending > 0 || status.processing > 0) {
    throw new Error("Timed out waiting for all five invoices to finish processing.");
  }

  if (status.failed > 0) {
    throw new Error(`${status.failed} invoice(s) failed. Inspect the status response.`);
  }

  // Review-required invoices are not silently treated as extraction failures.
  console.log(`\nProcessing finished. Review required: ${status.reviewRequired ?? "unknown"}`);

  const resultResponse = await fetch(
    `${baseUrl}/api/testing/invoices/result/${encodeURIComponent(batchId)}`,
    {
      headers: {
        "x-billora-test-token": token
      }
    }
  );

  if (!resultResponse.ok) {
    const errorBody = await resultResponse.text();
    throw new Error(`Excel download failed: HTTP ${resultResponse.status}\n${errorBody}`);
  }

  const contentType = resultResponse.headers.get("content-type") || "";
  if (!contentType.includes("spreadsheet") &&
      !contentType.includes("octet-stream")) {
    throw new Error(`Unexpected download content-type: ${contentType}`);
  }

  const workbook = Buffer.from(await resultResponse.arrayBuffer());

  // XLSX files are ZIP containers and start with PK.
  if (workbook.length < 4 || workbook[0] !== 0x50 || workbook[1] !== 0x4b) {
    throw new Error("Downloaded result is not a valid XLSX/ZIP file.");
  }

  const outputDir = path.resolve(here, "../../test-results");
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `billora-five-file-${batchId}.xlsx`);
  fs.writeFileSync(outputPath, workbook);

  console.log("\nSUCCESS");
  console.log(`Batch ID: ${batchId}`);
  console.log(`Uploaded: ${uploads.length}`);
  console.log(`Workbook bytes: ${workbook.length}`);
  console.log(`Saved: ${outputPath}`);
}

main().catch(error => {
  console.error("\nTEST FAILED");
  console.error(error);
  process.exitCode = 1;
});
