import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../../config/config.js";

// Custom metrics
const apiFailures = new Counter('api_failures');
const successRate = new Rate('successful_requests');
const rscResponseTime = new Counter('rsc_response_time');
const taskDetailRequests = new Counter('task_detail_requests');

// K6 load test options
export const options = {
  scenarios: {
    rsc_task_detail: {
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

// Setup: Login with PROVIDER credentials and get task IDs
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
  
  // Get some task IDs to test with
  const taskIds = [
    "jh7bcj36tx9sexa68sh6yaca397v59s1", // From your example
    "jh76vbcg78q2eg65v2dejhsnf57s2m6t", // From previous responses
    "jh70pfdnsftebg49xdf4985fg97s22ns"  // From previous responses
  ];
  
  return { 
    token: token,
    sessionCookie: sessionCookie,
    userId: responseBody.user.id,
    userEmail: responseBody.user.email,
    userRole: responseBody.user.role,
    taskIds: taskIds
  };
}

// Generate dynamic RSC headers for task detail page
function generateTaskDetailRSCHeaders(sessionCookie, taskId) {
  // Create the router state tree for task detail page
  const encodedRouterState = encodeURIComponent(
    JSON.stringify([
      "",
      {
        "children": [
          "tasks",
          {
            "children": [
              ["id", taskId, "d"],
              {
                "children": [
                  "__PAGE__",
                  {},
                  `/tasks/${taskId}`,
                  "refetch"
                ]
              }
            ]
          }
        ]
      }
    ])
  );

  const headers = {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.8",
    "next-router-state-tree": encodedRouterState,
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

// Extract task detail validation
function validateTaskDetailResponse(responseBody, taskId) {
  const validations = {
    hasRSCFormat: responseBody.includes('$Sreact.') || responseBody.includes('I['),
    hasTaskComponent: responseBody.includes('["id","' + taskId),
    hasLoadingState: responseBody.includes('Loading...'),
    hasMetadata: responseBody.includes('Ezyscribe v2'),
    hasViewport: responseBody.includes('viewport'),
    hasTaskDetailComponent: responseBody.includes('app/tasks/%5Bid%5D/page') // [id] page component
  };
  
  return validations;
}

// Extract task-specific data from response
function extractTaskDetailData(responseBody, taskId) {
  try {
    const data = {
      hasTaskIdInResponse: responseBody.includes(taskId),
      hasTaskDetailStructure: responseBody.includes('"children":["$","$Lf",null,{"id":"' + taskId + '"}]'),
      hasSuspenseBoundary: responseBody.includes('$Sreact.suspense'),
      hasMetadataComponents: responseBody.includes('AsyncMetadata') && responseBody.includes('MetadataBoundary')
    };
    
    return data;
  } catch (e) {
    return {
      hasTaskIdInResponse: false,
      hasTaskDetailStructure: false,
      hasSuspenseBoundary: false,
      hasMetadataComponents: false
    };
  }
}

// Default function executed by each VU
export default function (data) {
  const { token, sessionCookie, userId, userEmail, userRole, taskIds } = data;
  
  // Select a random task ID from available IDs
  const taskId = taskIds[Math.floor(Math.random() * taskIds.length)];
  
  // RSC endpoint for single task detail
  const url = `${CONFIG.Url}/tasks/${taskId}?_rsc=${Date.now()}`;
  
  // Generate dynamic RSC headers for task detail
  const headers = generateTaskDetailRSCHeaders(sessionCookie, taskId);

  // Log request details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("🔍 Making TASK DETAIL RSC request to:", url);
    console.log(`📋 Task ID: ${taskId}`);
    console.log(`👤 Authenticated as: ${userEmail}`);
  }

  // GET request to fetch task detail via RSC
  const startTime = Date.now();
  const res = http.get(url, { 
    headers: headers,
    tags: { name: 'rsc-task-detail' }
  });
  const responseTime = Date.now() - startTime;
  rscResponseTime.add(responseTime);
  taskDetailRequests.add(1);

  // Log sample response for first iteration of first VU
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Response Status:", res.status);
    console.log("⏱️ Response Time:", responseTime + "ms");
    
    if (res.status === 200) {
      console.log("✅ SUCCESS! Task Detail RSC response received");
      console.log("📋 Sample Response (first 300 chars):", res.body.substring(0, 300));
      
      // Validate task detail data
      const validations = validateTaskDetailResponse(res.body, taskId);
      console.log("🔍 Task Detail Validation:", validations);
      
      const taskData = extractTaskDetailData(res.body, taskId);
      console.log("🔍 Task Data Extraction:", taskData);
    } else {
      console.log("📋 Error Response:", res.body);
    }
  }

  // Handle error statuses
  if (res.status >= 400) {
    apiFailures.add(1);
    successRate.add(0);
    
    if (__VU === 1 && __ITER === 0) {
      console.error(`❌ Task Detail RSC call failed: ${res.status} - ${res.body}`);
    }
    
    check(res, {
      "❌ Task Detail RSC failed": (r) => false,
    });
    sleep(1);
    return;
  }

  // SUCCESS CASE - Status 200
  successRate.add(1);
  
  // Validate task detail response data
  const validations = validateTaskDetailResponse(res.body, taskId);
  const taskData = extractTaskDetailData(res.body, taskId);

  // Comprehensive validation checks for task detail RSC response
  check(res, {
    "✅ Task Detail RSC status is 200": (r) => r.status === 200,
    "✅ Response contains RSC format": (r) => 
      validations.hasRSCFormat,
    "✅ Response includes task ID": (r) => 
      validations.hasTaskComponent,
    "✅ Response has loading state": (r) => 
      validations.hasLoadingState,
    "✅ Response includes metadata": (r) => 
      validations.hasMetadata,
    "✅ Response has task detail component": (r) => 
      validations.hasTaskDetailComponent,
    "✅ Response time under 3s": (r) => responseTime < 3000,
  });

  // Additional validation for task detail structure
  if (res.status === 200) {
    check(res, {
      "✅ Contains task ID in response": () => 
        taskData.hasTaskIdInResponse,
      "✅ Has task detail component structure": () => 
        taskData.hasTaskDetailStructure,
      "✅ Has suspense boundary": () => 
        taskData.hasSuspenseBoundary,
      "✅ Has metadata components": () => 
        taskData.hasMetadataComponents,
      "✅ Proper RSC content type": () => 
        res.headers['Content-Type'] && res.headers['Content-Type'].includes('text/x-component'),
    });

    // Log successful details for first VU
    if (__VU === 1 && __ITER === 0) {
      console.log("✅ Task Detail RSC successful!");
      console.log(`⏱️ Response Time: ${responseTime}ms`);
      console.log(`📋 Task ID processed: ${taskId}`);
      console.log(`📊 Has Task Structure: ${taskData.hasTaskDetailStructure}`);
      console.log(`📊 Has Loading State: ${validations.hasLoadingState}`);
      console.log(`📊 Has Metadata: ${validations.hasMetadata}`);
      
      // Check if this is a loading state or full detail
      if (validations.hasLoadingState) {
        console.log("🔄 Response shows loading state (suspense boundary active)");
      } else {
        console.log("✅ Response likely contains full task details");
      }
    }
  }

  sleep(1);
}

export function teardown() {
  console.log(`\n📊 TASK DETAIL RSC TEST COMPLETE`);
  console.log(`🎯 Test executed for individual task detail pages`);
  console.log(`👤 Using provider account: ${CONFIG.provider.email}`);
}