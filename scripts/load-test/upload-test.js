import http from 'k6/http';
import { sleep, check } from 'k6';

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    'http_req_duration': ['p(95)<500'],
    'http_req_failed': ['rate<0.01'],
  },
};

export default function () {
  // Upload a test file
  const filePath = __SCRIPT_DIR + '/support-files/test-file.txt';
  const formData = {
    file: http.file(filePath, 'test-file.txt'),
  };

  const response = http.post('https://your-grafana-instance/api/datasources/attachments', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });

  check(response, {
    'upload status is 200': (r) => r.status === 200,
  });

  sleep(1);
}