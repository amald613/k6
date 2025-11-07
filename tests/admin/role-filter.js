import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../../config/config.js";

// Custom metrics
const apiFailures = new Counter('api_failures');
const successRate = new Rate('successful_requests');
const roleFilterOperations = new Counter('role_filter_operations');

// Available roles for testing
const ROLES = ["scribe", "scribeAdmin", "provider", "demo", "admin"];

// K6 load test options
export const options = {
  scenarios: {
    admin_role_filter: {
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
    'role_filter_operations': ['count>0'],
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
  
  // Role filter scenarios - only testing role parameter
  const roleScenarios = [
    {
      role: "admin",
      description: "Filter users with admin role"
    },
    {
      role: "scribe", 
      description: "Filter users with scribe role"
    },
    {
      role: "scribeAdmin",
      description: "Filter users with scribeAdmin role"
    },
    {
      role: "provider",
      description: "Filter users with provider role"
    },
    {
      role: "demo",
      description: "Filter users with demo role"
    },
    {
      role: "",
      description: "No role filter (all users)"
    }
  ];
  
  // Select a random role scenario for each iteration
  const scenario = roleScenarios[Math.floor(Math.random() * roleScenarios.length)];
  const page = Math.floor(Math.random() * 5) + 1; // Random page between 1-5
  const limit = 10;
  
  // Build the search URL with only role parameter
  let searchUrl = `https://appv2.ezyscribe.com/api/admin/users?page=${page}&limit=${limit}`;
  
  // Add role parameter if specified
  if (scenario.role) {
    searchUrl += `&role=${scenario.role}`;
  }
  
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
    "referer": "https://appv2.ezyscribe.com/admin/dashboard/users/view?page=1&limit=10",
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
    console.log("🎭 Making ROLE FILTER request to:", searchUrl);
    console.log("🔍 Role filter:", scenario.role || "ALL ROLES");
    console.log("📄 Page:", page);
    console.log("📝 Scenario:", scenario.description);
  }

  // GET request to filter users by role
  const res = http.get(searchUrl, { 
    headers: headers
  });

  // Log sample response for first iteration of first VU
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Role Filter Response Status:", res.status);
    
    if (res.status === 200) {
      try {
        const responseData = res.json();
        console.log("✅ ROLE FILTER SUCCESS!");
        console.log("📋 Total users found:", responseData.users?.length);
        
        if (responseData.users && responseData.users.length > 0) {
          const sampleUser = responseData.users[0];
          console.log("📋 Sample user email:", sampleUser.email);
          console.log("📋 Sample user role:", sampleUser.role);
          
          // Validate role filtering
          if (scenario.role) {
            const allMatchRole = responseData.users.every(user => user.role === scenario.role);
            console.log(`🎯 All users match role '${scenario.role}':`, allMatchRole);
          } else {
            console.log("🎯 No role filter applied - mixed roles returned");
          }
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
      console.error(`❌ Role filter API call failed: ${res.status} - ${res.body}`);
    }
    
    check(res, {
      "❌ Admin role-filter failed": (r) => false,
    });
    sleep(1);
    return;
  }

  // SUCCESS CASE - Status 200
  successRate.add(1);
  roleFilterOperations.add(1);
  
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
    "✅ Admin role-filter status is 200": (r) => r.status === 200,
    "✅ Response has users array": (r) => 
      Array.isArray(responseBody.users),
    "✅ Search response structure is valid": (r) => 
      responseBody.users !== undefined,
  });

  // Role-specific validation when role filter is applied
  if (scenario.role && responseBody.users && responseBody.users.length > 0) {
    check(res, {
      "✅ All users match selected role": (r) => 
        responseBody.users.every(user => user.role === scenario.role),
    });
  }

  // Additional validation for user object structure
  if (responseBody.users && responseBody.users.length > 0) {
    const sampleUser = responseBody.users[0];
    check(res, {
      "✅ User objects have required fields": (r) => 
        sampleUser.id && sampleUser.email && sampleUser.role,
      "✅ User role is valid": (r) => 
        ROLES.includes(sampleUser.role),
    });
  }

  // Log role filter performance for first VU
  if (__VU === 1 && __ITER % 10 === 0) {
    const roleDisplay = scenario.role || "ALL";
    console.log(`🎯 Role filter: ${roleDisplay} → ${responseBody.users?.length || 0} users`);
  }

  sleep(1);
}

export function teardown() {
  console.log(`\n📊 ADMIN ROLE FILTER TEST COMPLETE`);
}