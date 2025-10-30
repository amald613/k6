import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../config/config.js";

// Custom metrics
const loginFailures = new Counter('login_failures');
const successRate = new Rate('successful_logins');

// K6 load test options - Reduced to single user
export const options = {
  scenarios: {
    single_login: {
      executor: "per-vu-iterations",
      vus: 1,  // Only 1 virtual user
      iterations: 1,  // Only 1 iteration
      maxDuration: '30s',
    },
  },
  thresholds: {
    'login_failures': ['count<1'], // No failures allowed
    'successful_logins': ['rate>0.99'], // 99% success rate
    http_req_duration: ["p(95)<3000"],
    checks: ["rate>0.99"],
  },
};

// Setup: Single login that shares token with all tests
export function setup() {
  const url = `${CONFIG.baseUrl}/sign-in/email`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const payload = {
    email: CONFIG.user.email,
    password: CONFIG.user.password
  };

  console.log("🔐 Attempting login...");
  const res = http.post(url, JSON.stringify(payload), { headers });

  if (res.status === 200) {
    const responseBody = res.json();
    console.log("✅ Login successful!");
    console.log(`👤 User: ${responseBody.user.name}`);
    console.log(`🔑 Token: ${responseBody.token.substring(0, 20)}...`);
    
    return { 
      token: responseBody.token,
      user: responseBody.user 
    };
  } else {
    console.error(`❌ Login failed: ${res.status} - ${res.body}`);
    throw new Error(`Login failed with status: ${res.status}`);
  }
}

// Default function - Just validate the setup data
export default function (data) {
  const { token, user } = data;
  
  // Validate the token and user data received from setup
  check(data, {
    "✅ Token is present": () => token && token.length > 0,
    "✅ User data is present": () => user && user.id,
    "✅ User email matches": () => user.email === CONFIG.user.email,
  });

  console.log(`✅ VU ${__VU}: Using pre-authenticated token for user: ${user.name}`);
  
  // Now you can use this token for other API calls
  // Example: make authenticated requests here
  
  sleep(1);
}

export function teardown() {
  console.log(`\n📊 SINGLE LOGIN TEST COMPLETE`);
}