import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../../config/config.js";

// Custom metrics
const apiFailures = new Counter('api_failures');
const successRate = new Rate('successful_requests');
const rscResponseTime = new Counter('rsc_response_time');
const sortedRequests = new Counter('sorted_requests');

// K6 load test options
export const options = {
  scenarios: {
    rsc_sorted_tasks: {
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

// Generate dynamic RSC headers for sorted tasks
function generateSortedRSCHeaders(sessionCookie, sortConfig = { id: "taskNo", desc: false }) {
  // Create the router state tree with sort configuration
  const routerState = {
    sort: JSON.stringify([sortConfig])
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
              `/tasks?sort=${encodeURIComponent(JSON.stringify([sortConfig]))}`,
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

// Extract sorting validation from response
function validateSortedResponse(responseBody, expectedSort) {
  const validations = {
    hasRSCFormat: responseBody.includes('$Sreact.') || responseBody.includes('I['),
    hasSortParameter: responseBody.includes('"sort":') && responseBody.includes(expectedSort.id),
    hasSortDirection: responseBody.includes(`"desc":${expectedSort.desc}`),
    hasTaskData: responseBody.includes('"taskNo":'),
    hasSortArgs: responseBody.includes('"sortField":"' + expectedSort.id) || 
                 responseBody.includes('"sortDirection":"' + (expectedSort.desc ? 'desc' : 'asc')),
    hasSortedTasks: false // Will be determined by task order
  };
  
  return validations;
}

// Extract task order from response to verify sorting
function extractTaskOrder(responseBody) {
  try {
    // Extract task numbers from the response
    const taskNoMatches = responseBody.match(/"taskNo":(\d+)/g);
    if (!taskNoMatches) return { taskNumbers: [], isSorted: false };
    
    const taskNumbers = taskNoMatches.map(match => parseInt(match.replace('"taskNo":', '')));
    
    // Check if tasks are sorted in ascending order
    const isAscending = taskNumbers.every((num, index, array) => 
      index === 0 || num >= array[index - 1]
    );
    
    // Check if tasks are sorted in descending order
    const isDescending = taskNumbers.every((num, index, array) => 
      index === 0 || num <= array[index - 1]
    );
    
    return {
      taskNumbers,
      isAscending,
      isDescending,
      isSorted: isAscending || isDescending
    };
  } catch (e) {
    return { taskNumbers: [], isSorted: false };
  }
}

// Default function executed by each VU
export default function (data) {
  const { token, sessionCookie, userId, userEmail, userRole } = data;
  
  // Sort configuration - taskNo ascending
  const sortConfig = { id: "taskNo", desc: false };
  const sortQuery = encodeURIComponent(JSON.stringify([sortConfig]));
  
  // RSC endpoint for sorted tasks
  const url = `https://appv2.ezyscribe.com/tasks?sort=${sortQuery}&_rsc=${Date.now()}`;
  
  // Generate dynamic RSC headers with sort configuration
  const headers = generateSortedRSCHeaders(sessionCookie, sortConfig);

  // Log request details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("🔍 Making SORTED RSC request to:", url);
    console.log(`📊 Sort Configuration:`, sortConfig);
    console.log(`👤 Authenticated as: ${userEmail}`);
  }

  // GET request to fetch sorted tasks via RSC
  const startTime = Date.now();
  const res = http.get(url, { 
    headers: headers,
    tags: { name: 'rsc-sorted-tasks' }
  });
  const responseTime = Date.now() - startTime;
  rscResponseTime.add(responseTime);
  sortedRequests.add(1);

  // Log sample response for first iteration of first VU
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Response Status:", res.status);
    console.log("⏱️ Response Time:", responseTime + "ms");
    
    if (res.status === 200) {
      console.log("✅ SUCCESS! Sorted RSC response received");
      
      // Validate sorted data
      const validations = validateSortedResponse(res.body, sortConfig);
      console.log("🔍 Sort Validation:", validations);
      
      // Extract and verify task order
      const taskOrder = extractTaskOrder(res.body);
      console.log("🔍 Task Order Analysis:", {
        taskNumbers: taskOrder.taskNumbers,
        isSorted: taskOrder.isSorted,
        isAscending: taskOrder.isAscending,
        isDescending: taskOrder.isDescending
      });
    } else {
      console.log("📋 Error Response:", res.body);
    }
  }

  // Handle error statuses
  if (res.status >= 400) {
    apiFailures.add(1);
    successRate.add(0);
    
    if (__VU === 1 && __ITER === 0) {
      console.error(`❌ Sorted RSC call failed: ${res.status} - ${res.body}`);
    }
    
    check(res, {
      "❌ Sorted RSC tasks failed": (r) => false,
    });
    sleep(1);
    return;
  }

  // SUCCESS CASE - Status 200
  successRate.add(1);
  
  // Validate sorted response data
  const validations = validateSortedResponse(res.body, sortConfig);
  const taskOrder = extractTaskOrder(res.body);

  // Update validations with sorting verification
  validations.hasSortedTasks = taskOrder.isSorted;

  // Comprehensive validation checks for sorted RSC response
  check(res, {
    "✅ Sorted RSC status is 200": (r) => r.status === 200,
    "✅ Response contains RSC format": (r) => 
      validations.hasRSCFormat,
    "✅ Response includes task data": (r) => 
      validations.hasTaskData,
    "✅ Response has sort arguments": (r) => 
      validations.hasSortArgs,
    "✅ Response time under 3s": (r) => responseTime < 3000,
  });

  // Additional validation for sorted data structure
  if (res.status === 200) {
    // Check for loading skeleton and actual sorted data
    const hasSkeleton = res.body.includes('data-slot":"skeleton"');
    
    check(res, {
      "✅ Contains loading skeleton": () => hasSkeleton,
      "✅ Contains sorted task data": () => validations.hasTaskData,
      "✅ Tasks are properly sorted": () => taskOrder.isSorted,
      "✅ Tasks are in ascending order": () => taskOrder.isAscending,
      "✅ Proper RSC content type": () => 
        res.headers['Content-Type'] && res.headers['Content-Type'].includes('text/x-component'),
    });

    // Log successful details for first VU
    if (__VU === 1 && __ITER === 0) {
      console.log("✅ Sorted RSC Tasks successful!");
      console.log(`⏱️ Response Time: ${responseTime}ms`);
      console.log(`📊 Sort Field: ${sortConfig.id}`);
      console.log(`📊 Sort Direction: ${sortConfig.desc ? 'descending' : 'ascending'}`);
      console.log(`📊 Tasks Returned: ${taskOrder.taskNumbers.length}`);
      console.log(`📊 Tasks Sorted: ${taskOrder.isSorted}`);
      console.log(`📊 Ascending Order: ${taskOrder.isAscending}`);
      console.log(`📊 Task Numbers: ${taskOrder.taskNumbers.join(', ')}`);
      
      if (taskOrder.isSorted && taskOrder.isAscending) {
        console.log(`✅ SORTING VERIFIED: Tasks are correctly sorted in ascending order by taskNo`);
      } else if (taskOrder.isSorted && taskOrder.isDescending) {
        console.log(`✅ SORTING VERIFIED: Tasks are correctly sorted in descending order by taskNo`);
      } else {
        console.log(`⚠️ SORTING WARNING: Tasks may not be properly sorted`);
      }
    }
  }

  sleep(1);
}

export function teardown() {
  console.log(`\n📊 SORTED RSC TASKS TEST COMPLETE`);
  console.log(`🎯 Test executed for sorted tasks (taskNo ascending)`);
  console.log(`👤 Using provider account: ${CONFIG.provider.email}`);
}