export const CONFIG = {
  baseUrl: "https://appv2.ezyscribe.com/api/auth",
  Url: "https://appv2.ezyscribe.com",
  user: {
    // IMPORTANT: For production, use environment variables.
    // Fallback to hardcoded values for local development only.
    email: process.env.ADMIN_EMAIL || "deepeshm@pennhealthinfo.com",
    password: process.env.ADMIN_PASSWORD || "Pennhealth@0925"
  },
  provider: {
    // IMPORTANT: For production, use environment variables.
    // Fallback to hardcoded values for local development only.
    email: process.env.PROVIDER_EMAIL || "testprovider@gmail.com", 
    password: process.env.PROVIDER_PASSWORD || "12345678" 
  }
};