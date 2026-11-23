import http from 'k6/http';
import { sleep, check } from 'k6';

export const options = {
  vus: 3,
  duration: '20s',
  thresholds: {
    'http_req_duration': ['p(90)<300'],
    'http_req_failed': ['rate<0.02'],
  },
};

export default function () {
  // Fetch results from the backend
  const response = http.get('https://your-api-endpoint/api/results');

  check(response, {
    'status code is 200': (r) => r.status === 200,
    'results array not empty': (r) => JSON.parse(r.body).length > 0,
  });

  sleep(1);
}