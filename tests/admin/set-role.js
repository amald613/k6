import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../../config/config.js";

// Custom metrics
const apiFailures = new Counter('api_failures');
const successRate = new Rate('successful_requests');

// K6 load test options - Focus only on performance thresholds
export const options = {
  scenarios: {
    set_user_role: {
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
    // Performance-only thresholds
    'http_req_duration': ["p(95)<3000"],  // 95% of requests under 3 seconds
    'http_req_failed': ['rate<0.05'],     // Less than 5% failed requests
    'successful_requests': ['rate>0.95'], // More than 95% success rate
  },
};

// Setup: Login and get list of users to modify
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
  
  // Get list of users to modify
  const listUsersUrl = `https://appv2.ezyscribe.com/api/auth/admin/list-users`;
  const headers = {
    "Accept": "application/json",
    "Authorization": `Bearer ${token}`,
  };
  
  if (sessionCookie) {
    headers["Cookie"] = sessionCookie;
  }
  
  const usersRes = http.get(listUsersUrl, { headers: headers });
  
  if (usersRes.status !== 200) {
    throw new Error("❌ Failed to get users list");
  }
  
  const usersData = usersRes.json();
  const users = usersData.users || [];
  
  console.log(`📋 Found ${users.length} users to modify`);
  
  // Filter out the current admin user to avoid modifying ourselves
  const currentUserEmail = CONFIG.user.email;
  const usersToModify = users.filter(user => user.email !== currentUserEmail);
  
  if (usersToModify.length === 0) {
    throw new Error("❌ No users found to modify (excluding current admin user)");
  }
  
  console.log(`🎯 ${usersToModify.length} users available for role modification`);
  
  return { 
    token: token,
    sessionCookie: sessionCookie,
    userId: responseBody.user.id,
    usersToModify: usersToModify
  };
}

// Available roles to cycle through
const ROLES = ["scribe", "scribeAdmin", "provider", "demo"];

// Get a role based on iteration count for variety
function getRole(iteration) {
  return ROLES[iteration % ROLES.length];
}

// Default function executed by each VU
export default function (data) {
  const { token, sessionCookie, userId, usersToModify } = data;
  
  const url = `https://appv2.ezyscribe.com/api/auth/admin/set-role`;
  
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

  // Select a user to modify (round-robin through available users)
  const userIndex = __ITER % usersToModify.length;
  const targetUser = usersToModify[userIndex];
  const newRole = getRole(__ITER);

  const payload = {
    userId: targetUser.id,
    role: newRole
  };

  // Log request details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("🔍 Making request to:", url);
    console.log("🎯 Target User:", targetUser.name, `(${targetUser.email})`);
    console.log("🔄 Changing role from:", targetUser.role, "to:", newRole);
    console.log("📋 Request Payload:", JSON.stringify(payload, null, 2));
  }

  // POST request to set user role
  const res = http.post(url, JSON.stringify(payload), { 
    headers: headers
  });

  // Log sample response for first iteration of first VU
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Response Status:", res.status);
    
    if (res.status === 200) {
      try {
        const responseData = res.json();
        console.log("✅ SUCCESS! Role updated");
        console.log("📋 Updated User:", JSON.stringify(responseData.user, null, 2));
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
    
    // Only performance-related checks
    check(res, {
      "❌ API returned error status": (r) => false,
    });
    sleep(1);
    return;
  }

  // SUCCESS CASE - Status 200
  successRate.add(1);
  
  // Only basic validation - no business logic
  check(res, {
    "✅ API returned 200 status": (r) => r.status === 200,
    "✅ Response is valid JSON": (r) => {
      try {
        r.json();
        return true;
      } catch (e) {
        return false;
      }
    },
  });

  // Log successful details for first VU (optional)
  if (__VU === 1 && __ITER === 0 && res.status === 200) {
    try {
      const responseData = res.json();
      console.log("✅ Set User Role successful!");
      console.log(`👤 User: ${responseData.user?.name} (${responseData.user?.email})`);
      console.log(`🔄 Role changed to: ${responseData.user?.role}`);
    } catch (e) {
      // Ignore parsing errors for performance testing
    }
  }

  sleep(1);
}

export function teardown() {
  console.log(`\n📊 SET USER ROLE TEST COMPLETE`);
}