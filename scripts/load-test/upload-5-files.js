
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const TEST_TOKEN = __ENV.TEST_TOKEN;

const files = [
  'invoice-01.pdf',
  'invoice-02.pdf',
  'invoice-03.pdf',
  'invoice-04.pdf',
  'invoice-05.pdf',
];

export const options = {
  vus: 1,
  iterations: 5,

  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};

export default function () {
  const filename = files[__ITER];

  const filePath = `./scripts/load-test/support-files/${filename}`;
  const file = open(filePath, 'b');

  const response = http.post(
    `${BASE_URL}/api/testing/invoices/upload`,
    {
      file: http.file(file, filename, 'application/pdf'),
      testRunId: 'billora-smoke-5',
    },
    {
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
      },
      tags: {
        endpoint: 'invoice-upload',
      },
    }
  );

  let body = {};

  try {
    body = response.json();
  } catch (_) {
    body = {};
  }

  check(response, {
    'upload accepted': (r) => r.status === 200 || r.status === 201,
    'response confirms success': () => body.ok === true,
    'invoice ID returned': () => Boolean(body.invoiceId),
    'job ID returned': () => Boolean(body.jobId),
  });

  console.log(
    `${filename}: HTTP ${response.status}, accepted=${body.ok === true}`
  );

  sleep(1);
}
