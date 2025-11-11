import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../../config/config.js";

// Custom metrics
const apiFailures = new Counter('api_failures');
const successRate = new Rate('successful_requests');
const rscResponseTime = new Counter('rsc_response_time');
const filteredTasksCount = new Counter('filtered_tasks_count');

// K6 load test options
export const options = {
  scenarios: {
    rsc_filtered_tasks: {
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
    email: CONFIG.provider.email,
    password: CONFIG.provider.password,
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

// Generate dynamic RSC headers for AI Draft filtered tasks
function generateRSCHeaders(sessionCookie, statusFilter = "AI Draft") {
  // Create the router state tree with status filter
  const routerState = {
    status: statusFilter
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
              `/tasks?status=${encodeURIComponent(statusFilter)}`,
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

// Extract task count from RSC response
function extractTaskCount(responseBody) {
  try {
    // Look for total count in the response
    const totalMatch = responseBody.match(/"total":(\d+)/);
    if (totalMatch) {
      return parseInt(totalMatch[1]);
    }
    
    // Alternative pattern for task count
    const statusCountsMatch = responseBody.match(/"AI Draft":(\d+)/);
    if (statusCountsMatch) {
      return parseInt(statusCountsMatch[1]);
    }
    
    return 0;
  } catch (e) {
    return 0;
  }
}

// Extract filtered task data validation
function validateFilteredTasks(responseBody, expectedStatus = "AI Draft") {
  const validations = {
    hasStatusFilter: responseBody.includes(`"status":["${expectedStatus}"]`),
    hasAIDraftTasks: responseBody.includes('"status":"AI Draft"'),
    hasTaskData: responseBody.includes('"taskNo":'),
    hasProviderData: responseBody.includes('providerId'),
    hasCorrectArgs: responseBody.includes('getTasksByFilters')
  };
  
  return validations;
}

// Default function executed by each VU
export default function (data) {
  const { token, sessionCookie, userId, userEmail, userRole } = data;
  
  // RSC endpoint for filtered tasks (AI Draft status)
  const statusFilter = "AI Draft";
  const url = `https://appv2.ezyscribe.com/tasks?status=${encodeURIComponent(statusFilter)}&_rsc=${Date.now()}`;
  
  // Generate dynamic RSC headers with status filter
  const headers = generateRSCHeaders(sessionCookie, statusFilter);

  // Log request details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("🔍 Making FILTERED RSC request to:", url);
    console.log(`🎯 Filter: ${statusFilter}`);
    console.log(`👤 Authenticated as: ${userEmail}`);
  }

  // GET request to fetch filtered tasks via RSC
  const startTime = Date.now();
  const res = http.get(url, { 
    headers: headers,
    tags: { name: 'rsc-filtered-tasks' }
  });
  const responseTime = Date.now() - startTime;
  rscResponseTime.add(responseTime);

  // Log sample response for first iteration of first VU
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Response Status:", res.status);
    console.log("⏱️ Response Time:", responseTime + "ms");
    
    if (res.status === 200) {
      console.log("✅ SUCCESS! Filtered RSC response received");
      
      // Extract and log task count
      const taskCount = extractTaskCount(res.body);
      console.log(`📊 Filtered Tasks Count: ${taskCount}`);
      
      // Validate filtered data
      const validations = validateFilteredTasks(res.body, statusFilter);
      console.log("🔍 Filter Validation:", validations);
    } else {
      console.log("📋 Error Response:", res.body);
    }
  }

  // Handle error statuses
  if (res.status >= 400) {
    apiFailures.add(1);
    successRate.add(0);
    
    if (__VU === 1 && __ITER === 0) {
      console.error(`❌ Filtered RSC call failed: ${res.status} - ${res.body}`);
    }
    
    check(res, {
      "❌ Filtered RSC tasks failed": (r) => false,
    });
    sleep(1);
    return;
  }

  // SUCCESS CASE - Status 200
  successRate.add(1);
  
  // Extract task count for metrics
  const taskCount = extractTaskCount(res.body);
  if (taskCount > 0) {
    filteredTasksCount.add(taskCount);
  }

  // Validate filtered response data
  const validations = validateFilteredTasks(res.body, statusFilter);

  // Comprehensive validation checks for filtered RSC response
  check(res, {
    "✅ Filtered RSC status is 200": (r) => r.status === 200,
    "✅ Response contains RSC format": (r) => 
      r.body.includes('$Sreact.') || r.body.includes('I['),
    "✅ Response includes status filter": (r) => 
      validations.hasStatusFilter,
    "✅ Response has AI Draft tasks": (r) => 
      validations.hasAIDraftTasks,
    "✅ Response includes task data": (r) => 
      validations.hasTaskData,
    "✅ Response time under 3s": (r) => responseTime < 3000,
  });

  // Additional validation for filtered data structure
  if (res.status === 200) {
    // Check for loading skeleton and actual filtered data
    const hasSkeleton = res.body.includes('data-slot":"skeleton"');
    
    check(res, {
      "✅ Contains loading skeleton": () => hasSkeleton,
      "✅ Contains filtered task data": () => validations.hasTaskData,
      "✅ Contains provider data": () => validations.hasProviderData,
      "✅ Has correct filter arguments": () => validations.hasCorrectArgs,
      "✅ Proper RSC content type": () => 
        res.headers['Content-Type'] && res.headers['Content-Type'].includes('text/x-component'),
    });

    // Log successful details for first VU
    if (__VU === 1 && __ITER === 0) {
      console.log("✅ Filtered RSC Tasks successful!");
      console.log(`⏱️ Response Time: ${responseTime}ms`);
      console.log(`📊 Tasks with '${statusFilter}' status: ${taskCount}`);
      console.log(`📊 Has Skeleton: ${hasSkeleton}`);
      console.log(`📊 Has AI Draft Tasks: ${validations.hasAIDraftTasks}`);
      
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
  console.log(`\n📊 FILTERED RSC TASKS TEST COMPLETE`);
  console.log(`🎯 Test executed for 'AI Draft' status tasks`);
  console.log(`👤 Using provider account: ${CONFIG.provider.email}`);
}