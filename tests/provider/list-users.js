import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../../config/config.js";

// Custom metrics
const apiFailures = new Counter('api_failures');
const successRate = new Rate('successful_requests');
const rscResponseTime = new Counter('rsc_response_time');

// K6 load test options
export const options = {
  scenarios: {
    rsc_tasks_load: {
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

// Setup: Login with PROVIDER credentials
export function setup() {
  const loginUrl = `${CONFIG.baseUrl}/sign-in/email`;
  const credentials = {
    email: CONFIG.provider.email,        // USING PROVIDER EMAIL
    password: CONFIG.provider.password,  // USING PROVIDER PASSWORD
  };
  
  const loginRes = http.post(loginUrl, JSON.stringify(credentials), {
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
  });
  
  check(loginRes, {
    "✅ Provider Login status is 200": (r) => r.status === 200,
  });
  
  const responseBody = loginRes.json();
  const token = responseBody.token;
  
  if (!token) {
    throw new Error("❌ Provider Login failed — token not found");
  }
  
  console.log("✅ Provider Login successful — token acquired");
  console.log(`👤 Logged in as: ${CONFIG.provider.email}`);
  
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
    userId: responseBody.user.id,
    userEmail: responseBody.user.email,
    userRole: responseBody.user.role
  };
}

// Generate dynamic RSC headers with current timestamp range
function generateRSCHeaders(sessionCookie) {
  const now = Date.now();
  const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
  
  // Create the router state tree with current date range
  const routerState = {
    createdAt: `${thirtyDaysAgo},${now}`
  };
  
  const encodedRouterState = encodeURIComponent(
    JSON.stringify([
      "",
      {
        "children": [
          "tasks",
          {
            "children": [
              `__PAGE__?${JSON.stringify(JSON.stringify(routerState))}`,
              {},
              `/tasks?createdAt=${thirtyDaysAgo},${now}`,
              "refresh"
            ]
          },
          null,
          null,
          true
        ]
      },
      null,
      null,
      true
    ])
  );

  const headers = {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.8",
    "next-router-state-tree": encodedRouterState,
    "next-url": "/tasks",
    "rsc": "1",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-gpc": "1",
  };
  
  // Add session cookie for authentication
  if (sessionCookie) {
    headers["cookie"] = sessionCookie;
  }
  
  return headers;
}

// Default function executed by each VU
export default function (data) {
  const { token, sessionCookie, userId, userEmail, userRole } = data;
  
  // RSC endpoint for tasks
  const url = `https://appv2.ezyscribe.com/tasks?_rsc=${Date.now()}`;
  
  // Generate dynamic RSC headers
  const headers = generateRSCHeaders(sessionCookie);

  // Log request details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("🔍 Making RSC request to:", url);
    console.log(`👤 Authenticated as: ${userEmail} (${userRole})`);
    console.log("📋 RSC Headers sample:", {
      "accept": headers.accept,
      "next-router-state-tree": headers["next-router-state-tree"]?.substring(0, 100) + "...",
      "rsc": headers.rsc,
      "hasCookie": !!headers.cookie
    });
  }

  // GET request to fetch tasks via RSC
  const startTime = Date.now();
  const res = http.get(url, { 
    headers: headers,
    tags: { name: 'rsc-tasks' }
  });
  const responseTime = Date.now() - startTime;
  rscResponseTime.add(responseTime);

  // Log sample response for first iteration of first VU
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Response Status:", res.status);
    console.log("⏱️ Response Time:", responseTime + "ms");
    
    if (res.status === 200) {
      console.log("✅ SUCCESS! RSC response received");
      // Log first 500 chars of response for debugging
      console.log("📋 Sample Response (first 500 chars):", res.body.substring(0, 500));
      
      // Check for provider-specific data
      if (res.body.includes('providerId')) {
        console.log("🔍 Response contains provider data");
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
      console.error(`❌ RSC call failed: ${res.status} - ${res.body}`);
    }
    
    check(res, {
      "❌ RSC tasks failed": (r) => false,
    });
    sleep(1);
    return;
  }

  // SUCCESS CASE - Status 200
  successRate.add(1);
  
  // Comprehensive validation checks for RSC response
  check(res, {
    "✅ RSC status is 200": (r) => r.status === 200,
    "✅ Response contains RSC format": (r) => 
      r.body.includes('$Sreact.') || r.body.includes('I['),
    "✅ Response has React components": (r) => 
      r.body.includes('fragment') || r.body.includes('suspense'),
    "✅ Response includes task data": (r) => 
      r.body.includes('getTasksByFilters') || r.body.includes('taskNo'),
    "✅ Response time under 3s": (r) => responseTime < 3000,
  });

  // Additional validation for RSC data structure
  if (res.status === 200) {
    // Check for loading skeleton (indicates proper RSC streaming)
    const hasSkeleton = res.body.includes('data-slot":"skeleton"');
    const hasTaskData = res.body.includes('"taskNo":');
    const hasProviderData = res.body.includes('providerId');
    
    check(res, {
      "✅ Contains loading skeleton": () => hasSkeleton,
      "✅ Contains actual task data": () => hasTaskData,
      "✅ Contains provider data": () => hasProviderData,
      "✅ Proper RSC content type": () => 
        res.headers['Content-Type'] && res.headers['Content-Type'].includes('text/x-component'),
    });

    // Log successful details for first VU
    if (__VU === 1 && __ITER === 0) {
      console.log("✅ RSC Tasks successful!");
      console.log(`⏱️ Response Time: ${responseTime}ms`);
      console.log(`📊 Has Skeleton: ${hasSkeleton}`);
      console.log(`📊 Has Task Data: ${hasTaskData}`);
      console.log(`📊 Has Provider Data: ${hasProviderData}`);
      
      // Extract and log task count if available
      const taskMatch = res.body.match(/"total":(\d+)/);
      if (taskMatch) {
        console.log(`📋 Total Tasks: ${taskMatch[1]}`);
      }
      
      // Extract provider ID if available
      const providerMatch = res.body.match(/"providerId":"([^"]+)"/);
      if (providerMatch) {
        console.log(`👤 Provider ID in response: ${providerMatch[1]}`);
      }
    }
  }

  sleep(1);
}

export function teardown() {
  console.log(`\n📊 RSC TASKS TEST COMPLETE`);
  console.log(`👤 Test executed using provider account: ${CONFIG.provider.email}`);
}