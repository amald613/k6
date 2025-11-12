import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../../config/config.js";

// Custom metrics
const apiFailures = new Counter('api_failures');
const successRate = new Rate('successful_requests');
const rscResponseTime = new Counter('rsc_response_time');
const filteredTasksCount = new Counter('filtered_tasks_count');
const priorityTasksCount = new Counter('priority_tasks_count');

// K6 load test options
export const options = {
  scenarios: {
    rsc_priority_tasks: {
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

// Generate dynamic RSC headers for priority filtered tasks
function generateRSCHeaders(sessionCookie, priorityFilter = "Medium") {
  // Create the router state tree with priority filter
  const routerState = {
    priority: priorityFilter
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
              `/tasks?priority=${encodeURIComponent(priorityFilter)}`,
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

// Extract task count and priority data from RSC response
function extractTaskData(responseBody) {
  try {
    // Look for total count in the response
    const totalMatch = responseBody.match(/"total":(\d+)/);
    const total = totalMatch ? parseInt(totalMatch[1]) : 0;
    
    // Look for priority counts
    const priorityCountsMatch = responseBody.match(/"priorityCounts":\{[^}]*"Medium":(\d+)/);
    const mediumPriorityCount = priorityCountsMatch ? parseInt(priorityCountsMatch[1]) : 0;
    
    // Count actual Medium priority tasks in the data
    const mediumTasks = (responseBody.match(/"priority":"Medium"/g) || []).length;
    
    return {
      total,
      mediumPriorityCount,
      actualMediumTasks: mediumTasks
    };
  } catch (e) {
    return { total: 0, mediumPriorityCount: 0, actualMediumTasks: 0 };
  }
}

// Extract filtered task data validation for priority
function validatePriorityFilteredTasks(responseBody, expectedPriority = "Medium") {
  const validations = {
    hasPriorityFilter: responseBody.includes(`"priority":["${expectedPriority}"]`),
    hasMediumPriorityTasks: responseBody.includes('"priority":"Medium"'),
    hasTaskData: responseBody.includes('"taskNo":'),
    hasProviderData: responseBody.includes('providerId'),
    hasCorrectArgs: responseBody.includes('getTasksByFilters'),
    hasPriorityCounts: responseBody.includes('"priorityCounts"')
  };
  
  return validations;
}

// Default function executed by each VU
export default function (data) {
  const { token, sessionCookie, userId, userEmail, userRole } = data;
  
  // RSC endpoint for priority filtered tasks (Medium priority)
  const priorityFilter = "Medium";
  const url = `https://appv2.ezyscribe.com/tasks?priority=${encodeURIComponent(priorityFilter)}&_rsc=${Date.now()}`;
  
  // Generate dynamic RSC headers with priority filter
  const headers = generateRSCHeaders(sessionCookie, priorityFilter);

  // Log request details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("🔍 Making PRIORITY-FILTERED RSC request to:", url);
    console.log(`🎯 Priority Filter: ${priorityFilter}`);
    console.log(`👤 Authenticated as: ${userEmail}`);
  }

  // GET request to fetch priority-filtered tasks via RSC
  const startTime = Date.now();
  const res = http.get(url, { 
    headers: headers,
    tags: { name: 'rsc-priority-tasks' }
  });
  const responseTime = Date.now() - startTime;
  rscResponseTime.add(responseTime);

  // Log sample response for first iteration of first VU
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Response Status:", res.status);
    console.log("⏱️ Response Time:", responseTime + "ms");
    
    if (res.status === 200) {
      console.log("✅ SUCCESS! Priority-Filtered RSC response received");
      
      // Extract and log task data
      const taskData = extractTaskData(res.body);
      console.log(`📊 Total Tasks: ${taskData.total}`);
      console.log(`📊 Medium Priority Count: ${taskData.mediumPriorityCount}`);
      console.log(`📊 Actual Medium Tasks: ${taskData.actualMediumTasks}`);
      
      // Validate filtered data
      const validations = validatePriorityFilteredTasks(res.body, priorityFilter);
      console.log("🔍 Priority Filter Validation:", validations);
    } else {
      console.log("📋 Error Response:", res.body);
    }
  }

  // Handle error statuses
  if (res.status >= 400) {
    apiFailures.add(1);
    successRate.add(0);
    
    if (__VU === 1 && __ITER === 0) {
      console.error(`❌ Priority-Filtered RSC call failed: ${res.status} - ${res.body}`);
    }
    
    check(res, {
      "❌ Priority-Filtered RSC tasks failed": (r) => false,
    });
    sleep(1);
    return;
  }

  // SUCCESS CASE - Status 200
  successRate.add(1);
  
  // Extract task data for metrics
  const taskData = extractTaskData(res.body);
  if (taskData.total > 0) {
    filteredTasksCount.add(taskData.total);
  }
  if (taskData.actualMediumTasks > 0) {
    priorityTasksCount.add(taskData.actualMediumTasks);
  }

  // Validate priority-filtered response data
  const validations = validatePriorityFilteredTasks(res.body, priorityFilter);

  // Comprehensive validation checks for priority-filtered RSC response
  check(res, {
    "✅ Priority-Filtered RSC status is 200": (r) => r.status === 200,
    "✅ Response contains RSC format": (r) => 
      r.body.includes('$Sreact.') || r.body.includes('I['),
    "✅ Response includes priority filter": (r) => 
      validations.hasPriorityFilter,
    "✅ Response has Medium priority tasks": (r) => 
      validations.hasMediumPriorityTasks,
    "✅ Response includes task data": (r) => 
      validations.hasTaskData,
    "✅ Response has priority counts": (r) => 
      validations.hasPriorityCounts,
    "✅ Response time under 3s": (r) => responseTime < 3000,
  });

  // Additional validation for priority-filtered data structure
  if (res.status === 200) {
    // Check for loading skeleton and actual filtered data
    const hasSkeleton = res.body.includes('data-slot":"skeleton"');
    
    check(res, {
      "✅ Contains loading skeleton": () => hasSkeleton,
      "✅ Contains priority-filtered task data": () => validations.hasTaskData,
      "✅ Contains provider data": () => validations.hasProviderData,
      "✅ Has correct priority filter arguments": () => validations.hasCorrectArgs,
      "✅ All tasks have Medium priority": () => 
        taskData.actualMediumTasks === taskData.total, // All returned tasks should be Medium priority
      "✅ Proper RSC content type": () => 
        res.headers['Content-Type'] && res.headers['Content-Type'].includes('text/x-component'),
    });

    // Log successful details for first VU
    if (__VU === 1 && __ITER === 0) {
      console.log("✅ Priority-Filtered RSC Tasks successful!");
      console.log(`⏱️ Response Time: ${responseTime}ms`);
      console.log(`📊 Total '${priorityFilter}' priority tasks: ${taskData.total}`);
      console.log(`📊 Has Skeleton: ${hasSkeleton}`);
      console.log(`📊 Has Medium Priority Tasks: ${validations.hasMediumPriorityTasks}`);
      console.log(`📊 Priority Counts Available: ${validations.hasPriorityCounts}`);
      
      // Verify filter accuracy
      if (taskData.actualMediumTasks === taskData.total) {
        console.log(`✅ FILTER ACCURACY: All ${taskData.total} tasks have '${priorityFilter}' priority`);
      } else {
        console.log(`⚠️ FILTER WARNING: ${taskData.actualMediumTasks}/${taskData.total} tasks have '${priorityFilter}' priority`);
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
  console.log(`\n📊 PRIORITY-FILTERED RSC TASKS TEST COMPLETE`);
  console.log(`🎯 Test executed for 'Medium' priority tasks`);
  console.log(`👤 Using provider account: ${CONFIG.provider.email}`);
}