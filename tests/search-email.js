import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../config/config.js";

// Custom metrics
const apiFailures = new Counter('api_failures');
const successRate = new Rate('successful_requests');
const searchOperations = new Counter('search_operations');

// K6 load test options
export const options = {
  scenarios: {
    admin_search_users: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 3 },
        { duration: "30s", target: 3 },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    'api_failures': ['count<5'],
    'successful_requests': ['rate>0.95'],
    'search_operations': ['count>0'],
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
  
  // Search terms to test different scenarios
  const searchTerms = [
    "test",           // Generic search
    "example",        // Domain search
    "user",           // Common prefix
    "176",            // Numeric ID search
    "admin",          // Role-based search
    "scribe",         // Specific role
    "",               // Empty search (should return all users)
  ];
  
  // Select a random search term for each iteration
  const searchTerm = searchTerms[Math.floor(Math.random() * searchTerms.length)];
  const page = Math.floor(Math.random() * 5) + 1; // Random page between 1-5
  const limit = 10;
  
  // Build the search URL with parameters
  const searchUrl = `https://appv2.ezyscribe.com/api/admin/users?email=${searchTerm}&page=${page}&limit=${limit}`;
  
  // Build headers dynamically
  const headers = {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.8",
    "sec-ch-ua": "\"Chromium\";v=\"142\", \"Brave\";v=\"142\", \"Not_A Brand\";v=\"99\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-gpc": "1",
    "referer": "https://appv2.ezyscribe.com/admin/dashboard/users/view?page=295&limit=10",
  };
  
  // Add authentication
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  
  // Add cookie only if we have it
  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  }

  // Log request details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("🔍 Making SEARCH request to:", searchUrl);
    console.log("📋 Search term:", searchTerm);
    console.log("📄 Page:", page);
    console.log("🔑 Token present:", !!token);
    console.log("🍪 Cookie present:", !!sessionCookie);
  }

  // GET request to search users by email
  const res = http.get(searchUrl, { 
    headers: headers
  });

  // Log sample response for first iteration of first VU
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Search Response Status:", res.status);
    
    if (res.status === 200) {
      try {
        const responseData = res.json();
        console.log("✅ SEARCH SUCCESS!");
        console.log("📋 Total users found:", responseData.users?.length);
        if (responseData.users && responseData.users.length > 0) {
          console.log("📋 Sample user:", responseData.users[0].email);
          console.log("📋 User name:", responseData.users[0].name?.substring(0, 50) + "...");
        }
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
      console.error(`❌ Search API call failed: ${res.status} - ${res.body}`);
    }
    
    check(res, {
      "❌ Admin search-users failed": (r) => false,
    });
    sleep(1);
    return;
  }

  // SUCCESS CASE - Status 200
  successRate.add(1);
  searchOperations.add(1);
  
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
    "✅ Admin search-users status is 200": (r) => r.status === 200,
    "✅ Response has users array": (r) => 
      Array.isArray(responseBody.users),
    "✅ Search response structure is valid": (r) => 
      responseBody.users !== undefined,
  });

  // Additional checks for non-empty searches
  if (searchTerm && responseBody.users && responseBody.users.length > 0) {
    check(res, {
      "✅ Users match search criteria": (r) => 
        responseBody.users.some(user => 
          user.email.includes(searchTerm) || 
          (user.name && user.name.includes(searchTerm))
        ),
    });
  }

  // Log search performance for first VU
  if (__VU === 1 && __ITER % 10 === 0) {
    console.log(`🔍 Search completed: "${searchTerm}" → ${responseBody.users?.length || 0} users found`);
  }

  sleep(1);
}

export function teardown() {
  console.log(`\n📊 ADMIN SEARCH USERS TEST COMPLETE`);
}