# UBS Framework Intro

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [API Object Configuration](#api-object-configuration)
- [CRUD Object Structure](#crud-object-structure)
- [Middleware Components](#middleware-components)
- [Customization](#customization)
- [Ease of Use](#ease-of-use)
- [Security](#security)
- [5-Minute Setup](#5-minute-setup)
- [Usage](#usage)
- [Installation](#installation)
- [License](#license)

## Overview

The goal of this architecture is to simplify server and API development by leveraging a central configuration for each API object and dynamically resolving components in middleware. This design provides a highly configurable and reusable structure that minimizes redundant code while automating key tasks such as authentication, parameter validation, and permission handling.

### Key Objectives:
- Automate authorization checks, parameter validation, and other common API tasks.
- Minimize redundant code through modular functionality like token validation and permission checking.
- Allow developers to focus on business logic rather than boilerplate setup.

## Features

- **Authorization and Token Validation**: Easily manage API access with configurable token-based authorization.
- **Parameter Validation**: Ensure API inputs meet predefined requirements before processing.
- **Modular Handlers**: Load and execute handlers dynamically from predefined directories.
- **OTP and Email Handling**: Includes support for sending and verifying OTPs as well as email notifications.
- **Middleware-Based Architecture**: API configurations are resolved in middleware, simplifying API logic.
- **Encryption and Multi-Step Processing**: Configure APIs with encryption and multi-step workflows.
- **Custom Query Handling**: Dynamically manage query types for CRUD operations.
- **Role-Based Permission Management**: Define permissions for each API endpoint to control access.

### Key Config Options:
- **authorization**: Controls access token validation.
- **multistep**: Enables multi-step processing for complex workflows. 
- **encryption**: Enables data encryption.
- **parameters**: Toggles parameter validation middleware.
- **validation**: Enables request data validation.
- **verifyOTP**: Manages OTP verification.

## API Object Structure

The system supports a structured CRUD object for defining API behavior. Below is an example CRUD object for handling "[ table ]":

```js
const parameters = require('./CRUD_parameters');
global.Crud[ table ]_object = {
  versions: {
    versionData: [
      {
        "*": {
          steps: [
            {
              config: {
                features: {
                  multistep: false,
                  parameters: true,
                  pagination: true,
                },
                communication: {
                  encryption: {
                    platformEncryption: true,
                  },
                },
                verification: {
                  otp: false,
                  accessToken: false,
                },
              },
              data: {
                parameters: parameters,
                apiInfo: {
                  query: {
                    queryNature: { Add: "INSERT", Update: "UPDATE", View: "SELECT", Delete: "DELETE", List: "SELECT" },
                    queryPayload: {
                      Add: "INSERT INTO [ table ] (...) VALUES (...)",
                      Update: "UPDATE [ table ] SET ... WHERE attachment_id = {{id}}",
                      List: "SELECT ... FROM [ table ]",
                      View: "SELECT ... FROM [ table ] WHERE attachment_id = {{id}}",
                      Delete: "UPDATE [ table ] SET status = 'inactive' WHERE attachment_id = {{id}}",
                    },
                    database: "mainDb",
                  },
                },
                requestMetaData: {
                  requestMethod: { Add: "POST", View: "GET", Update: "PUT", Delete: "DELETE", List: "GET" },
                  permission: { Add: "insert_[ table ]", View: "view_[ table ]", List: "list_[ table ]", Update: "update_[ table ]", Delete: "delete_[ table ]" },
                  pagination: { pageSize: 10 },
                },
              },
              response: {
                successMessage: "[ table ] retrieved successfully!",
                errorMessage: "Failed to retrieve [ table ].",
              },
            },
          ],
        },
      },
    ],
  },
};
```
or For Standalone APIs that just retrieve data

```js

global.RegularApi_object = {
  versions: {
    versionData: [
      {
        "*": {
          steps: [
            {
              config: {
                features: {
                  multistep: false,
                  parameters: true,
                  pagination: false,
                },
                communication: {
                  encryption: false
                },
                verification: {
                  otp: false,
                  accessToken: false,
                },
              },

              data: {
                parameters: []
                apiInfo: {
                  query: async (req, decryptedPayload) => {
                    return `
                      SELECT user_id, username, role
                      FROM users
                      WHERE username = {{username}}
                      AND password = {{password}}
                      AND status = 'active'
                    `;
                  },
                  database: "mainDb",
                },
                requestMetaData: {
                  requestMethod: "POST" // or NULL,
                  permission: "post_regular_api" //or NULL,
                },
              },

              response: {
                successMessage: "API successful!",
                errorMessage: "Invalid username or password.",
              },
            },
          ],
        },
      },
    ],
  },
};

```

#### API Object Rules

* API object names must follow the pattern `camelCase_object`.

  * The first letter may be **uppercase** if consistent with project conventions.

* Newly created APIs should be placed in Src/Apis/ProjectSpecificApis 

* Every API definition must exist as a single **global API object**, typically assigned like:

  ```js
  global.apiName_object = { ... }
  ```


## Middleware Components

The middleware system follows a staged execution pipeline with automatic memory management:

```javascript
// Example middleware execution flow
try {
    // Sequential stage execution
    for (const stage of middleware_config) {
        for (const func of stage.functions) {
            await func(req, res, decryptedPayload, apiObject);
        }
    }
} finally {
    // Automatic memory cleanup
    cleanupMemory([payload, decryptedPayload, apiObject]);
}
```



### Core Middleware Handlers:
1. **sendResponse**: Standardizes API responses.
2. **validateToken**: Validates access tokens.
3. **permissionChecker**: Checks user permissions.
4. **platformHandler**: Manages platform-specific requirements.
5. **queryResolver**: Processes and validates database queries.
6. **validateParametersMiddleware**: Ensures API request parameters are valid.
7. **versionChecker**: Validates API version compatibility.

### Middleware Directory Structure:
- `TokenValidation/`: Token validation and authentication
- `ParameterValidation/`: Request parameter validation
- `PlatformCheck/`: Platform-specific handling and encryption
- `VersionCheck/`: API version compatibility
- `QueryResolver/`: Database query processing
- `PermissionCheck/`: Access control and permissions

## Customization

This architecture is designed to be highly customizable:
- **Modify Configurations**: Easily enable/disable API features.
- **Extend Middleware**: Add custom middleware for specific needs.
- **Modify CRUD Queries**: Adapt database interactions to your requirements.

## Ease of Use

- **Minimal setup required** to get started.
- **Pre-configured handlers** for common tasks.
- **Automatic API resolution** based on configurations.

## Security

- **Two-Layer Encryption**: Supports platform-level and request-specific encryption.
- **Role-Based Access Control**: Defines permissions per endpoint.
- **Token-Based Authentication**: Ensures secure API interactions.

## 5-Minute Setup

1. **Clone the repository:**
   ```bash
   git clone <repository_url>
   cd <project_folder>
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Configure database connection** in `.env` file.
4. **Start the server:**
   ```bash
   npm start
   ```
5. **Your API is now live and ready to use!**

## Usage

- Define API object configurations.
- Middleware handles:
  - Token validation
  - Permission checks
  - Parameter validation
  - Query processing
  - Response handling
- Handlers execute API logic dynamically.

## Directory Structure

```
Services/
├── Integrations/
│   ├── AI/
│   ├── CronJobs/
│   ├── Database/
│   ├── FileHandling/
│   ├── Mailer/
│   ├── Payments/
│   └── Subscriptions/
├── Middlewares/
│   ├── ParameterValidation/
│   ├── PlatformCheck/
│   ├── QueryResolver/
│   ├── TokenValidation/
│   └── VersionCheck/
├── SysFunctions/
│   ├── ApiObjectFunctions/
│   ├── Encryption/
│   └── LogFunctions/
└── SysScripts/

Src/
├── Apis/
│   ├── GeneratedApis/
│   ├── ProjectSpecificApis/
│   ├── SecurityApis/
│   └── Templates/
├── Config/
└── HelperFunctions/
```

## Development Best Practices

1. **API Development**
   - Use CRUD templates for consistent implementation
   - Place custom APIs in appropriate directories
   - Follow versioning conventions

2. **Database Operations**
   - Use the Database abstraction layer
   - Implement proper error logging
   - Use transactions when needed
   - Enable pagination for large datasets
   - Use singleton connection where multiple (>10) query executions needed
   - Release in finally clause with connection.release()

3. **Security Measures**
   - Always validate input parameters
   - Implement proper authentication
   - Use platform encryption when required
   - Follow permission-based access control

4. **Error Handling**
   - Use the built-in error logging system
   - Implement proper try-catch blocks
   - Clean up resources in finally blocks
   - Follow standard error response format

5. **Message Logging**
   - Use logMessage to set color and logging
   - Toggle env variable LOG_MESSAGES where needed
## Installation

1. Clone the repository
2. Copy `sample_env` to `.env` and configure:
   ```bash
   cp sample_env .env
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Configure database connections in `Services/Integrations/Database/initializeDatabase.js`
5. Start the server:
   ```bash
   npm start
   ```
    