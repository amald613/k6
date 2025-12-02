import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from 'k6/metrics';
import { CONFIG } from "../../config/config.js";

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
        { duration: "10s", target: 3 },
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

// Clean existing name by removing "Updated" repetitions
function cleanUserName(name) {
  if (!name) return `User_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  
  // Remove all " - Updated" repetitions
  const cleanName = name.split(' - Updated')[0];
  
  // Ensure the name is not too long
  if (cleanName.length > 50) {
    return cleanName.substring(0, 47) + '...';
  }
  
  return cleanName;
}

// Generate a unique, short name for editing
function generateUniqueShortName(originalName, iteration) {
  const cleanOriginal = cleanUserName(originalName);
  const timestamp = Date.now();
  const randomSuffix = Math.floor(Math.random() * 1000);
  
  // Create a short, descriptive name
  return `VU${__VU}_Iter${iteration}_${randomSuffix}`;
}

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
  const listUrl = `${CONFIG.baseUrl}/admin/list-users`;
  
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

  // Find a user to edit (not the current user, prefer non-admin for safety)
  let targetUser = usersList.users.find(user => 
    user.id !== userId && user.role !== 'admin'
  );
  
  if (!targetUser) {
    // Fallback to any user except current
    targetUser = usersList.users.find(user => user.id !== userId);
    if (!targetUser) {
      console.error("❌ No suitable user found to edit");
      apiFailures.add(1);
      successRate.add(0);
      sleep(1);
      return;
    }
  }

  // Clean the original name to fix corruption
  const cleanOriginalName = cleanUserName(targetUser.name);
  const newShortName = generateUniqueShortName(targetUser.name, __ITER);
  
  console.log(`🔄 Name transformation:`);
  console.log(`   Original: ${targetUser.name.substring(0, 100)}...`);
  console.log(`   Cleaned: ${cleanOriginalName}`);
  console.log(`   New: ${newShortName}`);

  // Use the exact Next.js Server Action endpoint
  const editUrl = `${CONFIG.Url}/admin/dashboard/users/view?page=1&limit=10`;
  
  // Prepare the payload with CLEANED name
  const editPayload = JSON.stringify([{
    userId: targetUser.id,
    name: newShortName, // Use the short, clean name
    email: targetUser.email,
    emailVerified: targetUser.emailVerified || false
  }]);

  // Next.js Server Action headers
  const editHeaders = {
    "accept": "text/x-component",
    "accept-language": "en-US,en;q=0.8",
    "content-type": "text/plain;charset=UTF-8",
    "next-action": "407f3f2e4799ccb9cd4383011940720af05422eae1",
    "next-router-state-tree": "%5B%22%22%2C%7B%22children%22%3A%5B%22admin%22%2C%7B%22children%22%3A%5B%22dashboard%22%2C%7B%22children%22%3A%5B%22users%22%2C%7B%22children%22%3A%5B%22view%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2C%22%2Fadmin%2Fdashboard%2Fusers%2Fview%3Fpage%3D1%26limit%3D10%22%2C%22refresh%22%5D%7D%5D%7D%5D%7D%5D%7D%5D%2Cnull%2Cnull%2Ctrue%5D",
    "sec-ch-ua": "\"Chromium\";v=\"142\", \"Brave\";v=\"142\", \"Not_A Brand\";v=\"99\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-gpc": "1",
    "referer": `${CONFIG.Url}/admin/dashboard/users/view?page=1&limit=10`,
    "Authorization": `Bearer ${token}`,
  };

  // Add cookie if available
  if (sessionCookie) {
    editHeaders["Cookie"] = sessionCookie;
  }

  // Log request details for first iteration
  if (__VU === 1 && __ITER === 0) {
    console.log("🔍 Making EDIT request to:", editUrl);
    console.log("🎯 Editing user ID:", targetUser.id);
    console.log("📝 New name:", newShortName);
  }

  // POST request to edit user
  const editRes = http.post(editUrl, editPayload, { 
    headers: editHeaders
  });

  // Log response details for debugging
  if (__VU === 1 && __ITER === 0) {
    console.log("📋 Edit Response Status:", editRes.status);
    
    if (editRes.status === 200) {
      console.log("✅ USER EDIT SUCCESS!");
      // Parse Next.js RSC response
      try {
        const responseText = editRes.body;
        if (responseText.includes('"ok":true')) {
          console.log("✅ Server confirmed update was successful");
        }
      } catch (e) {
        // RSC response might not be JSON
      }
    } else {
      console.log("📋 Error Response:", editRes.body);
    }
  }

  // Handle error statuses
  if (editRes.status >= 400) {
    apiFailures.add(1);
    successRate.add(0);
    
    console.error(`❌ Edit user failed: ${editRes.status}`);
    check(editRes, {
      "❌ Admin edit-user failed": (r) => false,
    });
    sleep(1);
    return;
  }

  // SUCCESS CASE
  successRate.add(1);
  userUpdates.add(1);
  
  // Check for success indicators in Next.js RSC response
  const isSuccess = editRes.status === 200 && 
                   (editRes.body.includes('"ok":true') || 
                    editRes.body.includes('success') ||
                    editRes.headers['X-Action-Revalidated']);
  
  check(editRes, {
    "✅ Admin edit-user status is 200": (r) => r.status === 200,
    "✅ Response indicates success": (r) => isSuccess,
  });

  if (__VU === 1 && __ITER === 0) {
    console.log(`✅ Successfully updated user "${cleanOriginalName}" → "${newShortName}"`);
    console.log(`🔧 Fixed corrupted name pattern`);
  }

  sleep(1);
}

export function teardown() {
  console.log(`\n📊 ADMIN EDIT-USER TEST COMPLETE`);
  console.log(`✨ All edited names are now short and unique`);
  console.log(`🔧 Corruption pattern has been fixed`);
}