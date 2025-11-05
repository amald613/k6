import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../config/config.js";

// Custom metrics
const apiFailures = new Counter('api_failures');
const successRate = new Rate('successful_requests');

// K6 load test options
export const options = {
  scenarios: {
    admin_users: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 3 },
        { duration: "10s", target: 3 },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    'api_failures': ['count<5'],
    'successful_requests': ['rate>0.95'],
    http_req_duration: ["p(95)<3000"],
    checks: ["rate>0.95"],
  },
};

// Setup: Login and get both token and cookies
export function setup() {
  const loginUrl = `${CONFIG.baseUrl}/sign-in/email`;
  const credentials = {
    email: CONFIG.user.email,
    password: CONFIG.user.password,
  };
  
  const loginRes = http.post(loginUrl, JSON.stringify(credentials), {
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
  });
  
  check(loginRes, {
    "✅ Login status is 200": (r) => r.status === 200,
  });
  
  const responseBody = loginRes.json();
  const token = responseBody.token;
  
  if (!token) {
    throw new Error("❌ Login failed — token not found");
  }
  
  console.log("✅ Login successful — token acquired");
  
  // Extract the session cookie dynamically from login response
  let sessionCookie = "";
  if (loginRes.cookies && loginRes.cookies['__Secure-better-auth.session_token']) {
    const cookieObj = loginRes.cookies['__Secure-better-auth.session_token'][0];
    sessionCookie = `${cookieObj.name}=${cookieObj.value}`;
  }
  
  console.log("🍪 Session cookie extracted:", sessionCookie ? "Yes" : "No");
  
  return { 
    token: token,
    sessionCookie: sessionCookie,
    userId: responseBody.user.id
  };
}

// Default function executed by each VU
export default function (data) {
  const { token, sessionCookie, userId } = data;
  
  // Exact endpoint from Postman
  const url = `https://appv2.ezyscribe.com/api/auth/admin/list-users`;
  
  // Build headers dynamically
  const headers = {
    "Accept": "application/json",
    "Authorization": `Bearer ${token}`,
  };
  
  // Add cookie only if we have it
  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  }

  // Log request details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("🔍 Making request to:", url);
    console.log("🔑 Token:", token.substring(0, 20) + "...");
    console.log("🍪 Cookie present:", !!sessionCookie);
  }

  // GET request to list users
  const res = http.get(url, { 
    headers: headers
  });

  // Log sample response for first iteration of first VU
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Response Status:", res.status);
    
    if (res.status === 200) {
      try {
        const responseData = res.json();
        console.log("✅ SUCCESS! Total users:", responseData.users?.length);
        console.log("📋 Sample user:", responseData.users?.[0]?.name);
      } catch (e) {
        console.log("📋 Response Body:", res.body);
      }
    } else {
      console.log("📋 Error Response:", res.body);
    }
  }

  // Handle error statuses
  if (res.status >= 400) {
    apiFailures.add(1);
    successRate.add(0);
    
    if (__VU === 1 && __ITER === 0) {
      console.error(`❌ API call failed: ${res.status} - ${res.body}`);
    }
    
    check(res, {
      "❌ Admin list-users failed": (r) => false,
    });
    sleep(1);
    return;
  }

  // SUCCESS CASE - Status 200
  successRate.add(1);
  
  let responseBody;
  try {
    responseBody = res.json();
  } catch (e) {
    console.error(`❌ JSON parse error: ${e.message}`);
    apiFailures.add(1);
    successRate.add(0);
    sleep(1);
    return;
  }

  // Comprehensive validation checks
  check(res, {
    "✅ Admin list-users status is 200": (r) => r.status === 200,
    "✅ Response has users array": (r) => 
      Array.isArray(responseBody.users),
    "✅ Users array is not empty": (r) => 
      responseBody.users && responseBody.users.length > 0,
  });

  if (res.status === 200 && responseBody.users && responseBody.users.length > 0) {
    check(res, {
      "✅ First user has valid data": () => 
        responseBody.users[0].id && responseBody.users[0].email,
    });
  }

  sleep(1);
}

export function teardown() {
  console.log(`\n📊 ADMIN LIST-USERS TEST COMPLETE`);
}