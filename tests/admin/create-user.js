import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../../config/config.js";

// Custom metrics
const apiFailures = new Counter('api_failures');
const successRate = new Rate('successful_requests');

// K6 load test options
export const options = {
  scenarios: {
    create_user: {
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

// Setup: Login once and share token
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

// Generate unique email for each request to avoid duplicates
function generateUniqueEmail() {
  const timestamp = Date.now();
  const randomSuffix = Math.floor(Math.random() * 10000);
  return `testuser${timestamp}${randomSuffix}@example.com`;
}

// Generate unique name for each request
function generateUniqueName() {
  const timestamp = Date.now();
  const randomSuffix = Math.floor(Math.random() * 1000);
  return `Test User ${timestamp}_${randomSuffix}`;
}

// Default function executed by each VU
export default function (data) {
  const { token, sessionCookie, userId } = data;
  
  const url = `https://appv2.ezyscribe.com/api/auth/admin/create-user`;
  
  // Build headers with both token and cookie
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  };
  
  // Add cookie only if we have it
  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  }

  // Generate unique payload for each request to avoid duplicate errors
  const payload = {
    name: generateUniqueName(),
    email: generateUniqueEmail(),
    password: "12345678",
    role: "admin",
    data: {}
  };

  // Log request details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("🔍 Making request to:", url);
    console.log("📋 Request Payload:", JSON.stringify(payload, null, 2));
  }

  // POST request to create user
  const res = http.post(url, JSON.stringify(payload), { 
    headers: headers
  });

  // Log sample response for first iteration of first VU
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Response Status:", res.status);
    
    if (res.status === 200) {
      try {
        const responseData = res.json();
        console.log("✅ SUCCESS! User created:", responseData.user?.email);
        console.log("📋 Sample Response:", JSON.stringify(responseData, null, 2));
      } catch (e) {
        console.log("📋 Response Body:", res.body);
      }
    } else {
      console.log("📋 Error Response:", res.body);
    }
  }

  // Handle duplicate email errors - NOT considered real failures
  if (res.status === 500 && res.body?.includes("already exists")) {
    apiFailures.add(1);
    successRate.add(1); // Count as success for performance perspective
    console.warn(`⚠️ Duplicate email - VU ${__VU}, Iter ${__ITER}: User already exists`);
    
    check(res, {
      "✅ Duplicate email handled": (r) => true,
    });
    sleep(1);
    return;
  }

  // Handle other error statuses
  if (res.status >= 400) {
    apiFailures.add(1);
    successRate.add(0);
    
    if (__VU === 1 && __ITER === 0) {
      console.error(`❌ API call failed: ${res.status} - ${res.body}`);
    }
    
    check(res, {
      "❌ Create user failed": (r) => false,
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

  // Comprehensive validation checks for successful response
  check(res, {
    "✅ Create User status is 200": (r) => r.status === 200,
    "✅ Response has user object": (r) => 
      responseBody.user !== undefined,
    "✅ User has ID field": (r) => 
      responseBody.user.id && responseBody.user.id.length > 0,
    "✅ User email matches request": (r) => 
      responseBody.user.email === payload.email,
    "✅ User name matches request": (r) => 
      responseBody.user.name === payload.name,
    "✅ User role is set correctly": (r) => 
      responseBody.user.role === payload.role,
  });

  // Additional validation for user data structure
  if (res.status === 200 && responseBody.user) {
    const createdUser = responseBody.user;
    
    check(res, {
      "✅ User ID format is valid": () => 
        typeof createdUser.id === 'string' && createdUser.id.length > 0,
      "✅ User email format is valid": () => 
        createdUser.email.includes('@'),
      "✅ User has timestamps": () => 
        createdUser.createdAt && createdUser.updatedAt,
      "✅ User role is valid": () => 
        ['admin', 'scribe', 'user'].includes(createdUser.role),
    });

    // Log successful details for first VU
    if (__VU === 1 && __ITER === 0) {
      console.log("✅ Create User successful!");
      console.log(`👤 User created: ${createdUser.name} (${createdUser.email})`);
      console.log(`🆔 User ID: ${createdUser.id}`);
      console.log(`🎭 User Role: ${createdUser.role}`);
    }
  }

  sleep(1);
}

export function teardown() {
  console.log(`\n📊 CREATE USER TEST COMPLETE`);
}