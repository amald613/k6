import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../config/config.js";

// Custom metrics
const apiFailures = new Counter('api_failures');
const successRate = new Rate('successful_requests');
const userUpdates = new Counter('user_updates');

// K6 load test options
export const options = {
  scenarios: {
    admin_edit_users: {
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
    'user_updates': ['count>0'],
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
  
  // First, get a list of users to find one to edit
  const listUrl = `https://appv2.ezyscribe.com/api/auth/admin/list-users`;
  
  const listHeaders = {
    "Accept": "application/json",
    "Authorization": `Bearer ${token}`,
  };
  
  if (sessionCookie) {
    listHeaders["Cookie"] = sessionCookie;
  }

  const listRes = http.get(listUrl, { headers: listHeaders });

  if (listRes.status !== 200) {
    console.error(`❌ Failed to get users list: ${listRes.status}`);
    apiFailures.add(1);
    successRate.add(0);
    sleep(1);
    return;
  }

  let usersList;
  try {
    usersList = listRes.json();
  } catch (e) {
    console.error(`❌ JSON parse error for users list: ${e.message}`);
    apiFailures.add(1);
    successRate.add(0);
    sleep(1);
    return;
  }

  // Find a user to edit (not the current user)
  const targetUser = usersList.users.find(user => user.id !== userId);
  
  if (!targetUser) {
    console.error("❌ No suitable user found to edit");
    apiFailures.add(1);
    successRate.add(0);
    sleep(1);
    return;
  }

  // Use the exact Next.js Server Action endpoint from your original fetch
  const editUrl = `https://appv2.ezyscribe.com/admin/dashboard/users/view?page=289&limit=10`;
  
  // Prepare the exact payload format from your original fetch
  const editPayload = JSON.stringify([{
    userId: targetUser.id,
    name: `${targetUser.name} - Updated`,
    email: targetUser.email,
    emailVerified: targetUser.emailVerified || false
  }]);

  // Use the exact headers from your original fetch request
  const editHeaders = {
    "accept": "text/x-component",
    "accept-language": "en-US,en;q=0.8",
    "content-type": "text/plain;charset=UTF-8",
    "next-action": "407f3f2e4799ccb9cd4383011940720af05422eae1",
    "next-router-state-tree": "%5B%22%22%2C%7B%22children%22%3A%5B%22admin%22%2C%7B%22children%22%3A%5B%22dashboard%22%2C%7B%22children%22%3A%5B%22users%22%2C%7B%22children%22%3A%5B%22view%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2C%22%2Fadmin%2Fdashboard%2Fusers%2Fview%3Fpage%3D289%26limit%3D10%22%2C%22refresh%22%5D%7D%5D%7D%5D%7D%5D%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D",
    "sec-ch-ua": "\"Chromium\";v=\"142\", \"Brave\";v=\"142\", \"Not_A Brand\";v=\"99\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-gpc": "1",
    "referer": "https://appv2.ezyscribe.com/admin/dashboard/users/view?page=289&limit=10",
  };

  // Add authentication headers
  if (token) {
    editHeaders["Authorization"] = `Bearer ${token}`;
  }
  
  if (sessionCookie) {
    editHeaders["Cookie"] = sessionCookie;
  }

  // Log request details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("🔍 Making EDIT request to:", editUrl);
    console.log("🎯 Editing user:", targetUser.name);
    console.log("📝 Payload:", editPayload);
    console.log("🔑 Using Next.js Server Action format");
  }

  // POST request to edit user using Next.js Server Action
  const editRes = http.post(editUrl, editPayload, { 
    headers: editHeaders
  });

  // Log response details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Edit Response Status:", editRes.status);
    console.log("📋 Response Headers:", JSON.stringify(editRes.headers));
    
    if (editRes.status === 200) {
      console.log("✅ USER EDIT SUCCESS!");
      console.log("📋 Response Body:", editRes.body);
    } else {
      console.log("📋 Error Response Body:", editRes.body);
      console.log("🔧 Check if the Next.js action ID and router state tree are still valid");
    }
  }

  // Handle error statuses
  if (editRes.status >= 400) {
    apiFailures.add(1);
    successRate.add(0);
    
    if (__VU === 1 && __ITER === 0) {
      console.error(`❌ Edit user failed: ${editRes.status}`);
      
      // Additional debugging for Next.js specific issues
      if (editRes.status === 404) {
        console.log("\n🔧 NEXT.JS SPECIFIC DEBUGGING:");
        console.log("1. The Next.js action ID might have changed");
        console.log("2. The router state tree might be expired");
        console.log("3. Try capturing a fresh request from browser dev tools");
        console.log("4. Check if the page parameter (289) is still valid");
      }
    }
    
    check(editRes, {
      "❌ Admin edit-user failed": (r) => false,
    });
    sleep(1);
    return;
  }

  // SUCCESS CASE
  successRate.add(1);
  userUpdates.add(1);
  
  // For Next.js Server Actions, the response might be a React component stream
  // We'll check for successful status and any meaningful response
  check(editRes, {
    "✅ Admin edit-user status is 200": (r) => r.status === 200,
    "✅ Response received": (r) => r.body && r.body.length > 0,
  });

  if (__VU === 1 && __ITER === 0 && editRes.status === 200) {
    console.log("✅ Successfully updated user using Next.js Server Action");
  }

  sleep(1);
}

export function teardown() {
  console.log(`\n📊 ADMIN EDIT-USER TEST COMPLETE`);
}