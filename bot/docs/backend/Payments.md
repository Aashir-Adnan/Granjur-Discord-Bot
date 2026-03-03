# Payments Module

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Payment Gateway Architecture](#payment-gateway-architecture)
- [Gateway Implementation Structure](#gateway-implementation-structure)
- [Adding a New Gateway](#adding-a-new-gateway)
- [Payment Flows](#payment-flows)
- [Usage](#usage)
- [Directory Structure](#directory-structure)
- [Shared Services](#shared-services)
- [Database Tables](#database-tables)
- [Customization](#customization)
- [Development Best Practices](#development-best-practices)
- [Installation](#installation)
- [License](#license)

## Overview

The UBS Payments Framework provides an extensible and maintainable architecture for integrating multiple payment gateways in Node.js projects. It abstracts payment gateway specifics, centralizes business logic, and automates post-payment processing, allowing developers to focus on payment gateway integration rather than transaction management, subscription handling, and user activation.

### Key Objectives:
- Separate payment gateway specifics from business logic (transactions, subscriptions, credits, user activation).
- Enable easy addition of new payment gateways with minimal code changes.
- Automate post-payment workflows (subscription creation, credit allocation, user activation).

## Features

- **Multi-Gateway Support**: Interface for Stripe, Chase Bank (Authorize.net), KuickPay, and easily extensible for new gateways.
- **Automatic Transaction Management**: Creates, updates, and tracks payment transactions with full audit trail.
- **Post-Payment Automation**: Automatically handles subscription creation, credit allocation, user activation, and permission assignment.
- **Free Plan Support**: Built-in handling for zero-cost plans without payment method requirements.
- **Auto-Renewal Management**: Supports both gateway-driven and manual auto-renewal strategies.

## Payment Gateway Architecture

### Initialization Flow

1. **Gateway Selection**: Use `PaymentGatewayFactory.create(gatewayName)` to instantiate the appropriate gateway (e.g., `stripe`, `chasebank`, `kuickpay`).
2. **Manager Creation**: Create `PaymentGatewayManager` instance with gateway name and configuration.
3. **Connection Setup**: Manager uses `PaymentConnectionManager` to handle database connections.
4. **Service Registration**: Gateway is ready to process payments.

### Payment Initiation Flow

1. **API Request**: Application calls `paymentManager.initiatePayment(params)` with `urdd_id`, `plan_id`, `payment_method_id`, `amount`.
2. **Validation**: `PaymentGatewayBase` validates inputs, checks for duplicate recent attempts, and loads plan data.
3. **Transaction Creation**: Creates pending transaction record in database.
4. **Gateway Call**: Calls gateway-specific `gatewaySpecificInitiatePayment()` method.
5. **Status Update**: Updates transaction with gateway response and status.
6. **Post-Processing**: If successful, triggers subscription creation, credit allocation, and user activation.

### Post-Payment Processing Flow

1. **Subscription Creation**: `SubscriptionService` creates active subscription with correct expiry and auto-renew settings.
2. **Credit Allocation**: `CreditsService` allocates credits based on plan duration and renewal type.
3. **User Activation**: `UserActivationService` activates user/URDD, assigns permissions, and creates AI Credits tenant (if applicable).
4. **Permission Assignment**: Assigns plan-specific permissions and Ilmversity group permissions.

## Gateway Implementation Structure

Each payment gateway extends `PaymentGatewayBase` and implements gateway-specific methods:

- `gatewaySpecificInitiatePayment(connection, params)`: Initiate payment with gateway API.
- `gatewaySpecificConfirmPayment(connection, params)`: Confirm pending payments (for redirect-based flows).
- `gatewaySpecificCreatePaymentMethod(connection, params)`: Create and store payment method.
- `gatewaySpecificCreditTopUp(connection, params)`: Handle credit top-up transactions.

Example:

```js
const PaymentGatewayBase = require('../abstract/PaymentGatewayBase');

class <<Name>>Gateway extends PaymentGatewayBase {
  async gatewaySpecificInitiatePayment(connection, { urdd_id, plan_id, payment_method_id, amount, transaction_id, plan }) {
    const gatewayResponse = await <<Name>>GatewayAPI.createPayment({
      amount: amount,
      customer_id: payment_method_id
    });

    return {
      success: gatewayResponse.status === 'succeeded',
      status: gatewayResponse.status === 'succeeded' ? 'success' : 'pending',
      message: 'Payment initiated successfully',
      payment_intent_id: gatewayResponse.id,
      gateway_response: { gateway_id: gatewayResponse.id }
    };
  }
}
```

## Adding a New Gateway

To add a new payment gateway:

1. **Create Gateway Class**: Create `Services/Integrations/Payments/implementations/<<Name>>GatewayGateway.js` extending `PaymentGatewayBase`.
2. **Implement Required Methods**: Implement all `gatewaySpecific*` methods.
3. **Register in Factory**: Update `abstract/PaymentGatewayFactory.js`:

```js
const <<Name>>Gateway = require('../implementations/<<Name>>Gateway');

class PaymentGatewayFactory {
  static create(gatewayName, config = {}) {
    switch ((gatewayName || '').toLowerCase()) {
      case '<<Name>>gateway':
        return new <<Name>>Gateway(config);
      default:
        throw new Error(`Unsupported payment gateway: ${gatewayName}`);
    }
  }
}
```

4. **Add Configuration** (Optional): Create `config/<<Name>>Gateway.config.js` for gateway-specific settings.

## Payment Flows

### Payment Initiation Flow

The payment initiation process follows a sequential flow where each step builds upon the previous one, ensuring data integrity and proper transaction tracking.

```
┌─────────────────┐
│  API Request    │  User initiates payment with plan and payment method
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Validation     │  Validate inputs, load plan data
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Create Pending  │  Create transaction record with 'pending' status
│  Transaction    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Gateway API     │  Call gateway-specific payment initiation
│    Call         │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Update Status   │  Update transaction with gateway response
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Post-Processing │  If successful: create subscription, allocate credits,
│  (if success)   │  activate user, assign permissions
└─────────────────┘
```

**Flow Explanation:**

1. **API Request**: The application receives a payment request containing user identification (`urdd_id`), selected plan (`plan_id`), payment method (`payment_method_id`), and transaction amount.

2. **Validation**: The base class performs input validation,  and retrieves plan details from the database to ensure the plan is active and valid.

3. **Create Pending Transaction**: A transaction record is created in the database with a `pending` status. This serves as an audit trail and allows tracking of payment attempts even if they fail.

4. **Gateway API Call**: The gateway-specific implementation method is called, which communicates with the external payment gateway API (Stripe, Chase Bank, etc.) to initiate the payment process.

5. **Update Status**: The transaction record is updated with the gateway's response, including status (`success`, `pending`, or `failed`), gateway-specific identifiers, and any additional metadata.

6. **Post-Processing**: If the payment status is `success`, the system automatically triggers post-payment workflows including subscription creation, credit allocation, user activation, and permission assignment.



### Status Check Flow

The status check allows querying the current state of a payment transaction without modifying it.

```
┌─────────────────┐
│ Status Request  │  Query transaction by ID
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Retrieve        │  Fetch transaction from database
│ Transaction     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Return Status   │  Return current status and gateway response
└─────────────────┘
```

**Flow Explanation:**

1. **Status Request**: A status check request is made with the transaction ID.

2. **Retrieve Transaction**: The system queries the database to retrieve the transaction record, including its current status and stored gateway response.

3. **Return Status**: The current transaction status (`pending`, `success`, or `failed`) along with any gateway-specific metadata is returned to the caller.




## Usage

- **Initiate Payment**: `paymentManager.initiatePayment({ urdd_id, plan_id, payment_method_id, amount })`
- **Confirm Payment**: `paymentManager.confirmPayment({ transaction_id, payment_intent_id })`
- **Check Status**: `paymentManager.getStatus(transactionId)`
- **Credit Top-Up**: `paymentManager.creditTopUp({ urdd_id, subscription_id, additional_credits, amount })`
- **Create Payment Method**: `paymentManager.createPaymentMethod({ urdd_id, gateway, payment_data })`

## Directory Structure

```
Services/
├── Integrations/
│   └── Payments/
│       ├── PaymentGatewayManager.js
│       ├── abstract/
│       │   ├── PaymentGatewayBase.js
│       │   └── PaymentGatewayFactory.js
│       ├── implementations/
│       │   ├── StripeGateway.js
│       │   ├── ChaseBankGateway.js
│       │   └── KuickPayGateway.js
│       ├── shared/
│       │   ├── PaymentTransactionService.js
│       │   ├── SubscriptionService.js
│       │   ├── CreditsService.js
│       │   └── UserActivationService.js
│       └── config/
```

## Database Tables

The Payments module interacts with several database tables to track transactions, subscriptions, credits, and user payment methods. Understanding these tables helps in debugging and extending the payment system.

### transactions

Stores all payment attempts and their status.

```js
{
  id: Number,                    // Unique transaction identifier
  urdd_id: Number,               // User role designation department ID
  plan_id: Number,               // Plan being purchased
  subscription_id: Number,       // Linked subscription (set after successful payment)
  user_payment_method_id: Number, // Payment method used
  amount: Decimal,               // Transaction amount
  currency_id: Number,           // Currency identifier
  transaction_type: String,      // 'subscription_payment' | 'credit_top_up' | 'free_plan'
  status: String,                // 'pending' | 'success' | 'failed'
  gateway_response: JSON,        // Gateway-specific data (payment_intent_id, etc.)
  description: String,           // Human-readable transaction description
  created_at: DateTime,          // Creation timestamp
  updated_at: DateTime           // Last update timestamp
}
```

**Data Flow:**
- **INSERT**: Created with `status='pending'` during payment initiation
- **UPDATE**: Status updated to `success` or `failed` after gateway response
- **UPDATE**: `subscription_id` linked after subscription creation

### application_subscriptions

Tracks active and upcoming subscriptions for users.

```js
{
  id: Number,                    // Unique subscription identifier
  urdd_id: Number,               // User role designation department ID
  plan_id: Number,               // Associated plan
  user_payment_method_id: Number, // Payment method for renewals
  status: String,                // 'active' | 'inactive' | 'upcoming'
  start_date: DateTime,          // Subscription start date
  expiry_date: DateTime | null,  // Subscription expiry (NULL for lifetime plans)
  auto_renew: Boolean,           // Auto-renewal flag (0 or 1)
  gateway_subscription_id: String, // Gateway's subscription ID (if applicable)
  subdomain: String              // AI Credits tenant subdomain (if applicable)
}
```

**Data Flow:**
- **INSERT**: Created after successful payment with `status='active'`
- **UPDATE**: `expiry_date` and `auto_renew` set based on plan duration
- **UPDATE**: Status changed to `inactive` on cancellation or upgrade

### subscription_renewal

Tracks credit allocations for each subscription renewal or purchase.

```js
{
  id: Number,                    // Unique renewal record identifier
  subscription_id: Number,       // Linked subscription
  transaction_id: Number,        // Associated transaction
  credits_given: Number,         // Amount of credits allocated
  credits_used: Number,          // Amount of credits consumed
  status: String,                // 'active' | 'expired'
  renewal_type: String,          // 'initial_purchase' | 'renewal' | 'credit_top_up'
  expiry_date: DateTime,         // Credit expiry date
  created_at: DateTime           // Creation timestamp
}
```

**Data Flow:**
- **INSERT**: Created after successful payment with credits from plan
- **UPDATE**: `credits_used` incremented as user consumes credits
- **QUERY**: Used to check available credits and expiry

### user_payment_methods

Stores saved payment methods for users.

```js
{
  id: Number,                    // Unique payment method identifier
  urdd_id: Number,               // User role designation department ID
  supported_payment_method_id: Number, // Reference to payment gateway type
  payment_details: JSON,         // Gateway-specific payment data
  is_verified: Boolean,          // Verification status (0 or 1)
  verification_status: String,   // Verification state
  is_default: Boolean,           // Default payment method flag (0 or 1)
  is_active: Boolean             // Active status flag (0 or 1)
}
```

**Data Flow:**
- **INSERT**: Created when user adds a payment method
- **UPDATE**: `is_default` updated when setting default method
- **QUERY**: Retrieved during payment initiation

### supported_payment_methods

Reference table for available payment gateways.

```js
{
  id: Number,                    // Payment method type identifier
  name: String,                  // Gateway name ('stripe' | 'chasebank' | 'kuickpay')
  auto_renewal_type: String      // Renewal strategy ('manual' | 'gateway')
}
```

**Usage:**
- Referenced by `user_payment_methods` to identify gateway type
- Used to determine auto-renewal behavior

### Payment Flow Database Operations

The following diagram shows how data flows through tables during a successful payment:

```
Payment Initiation
       │
       ▼
┌──────────────────┐
│  transactions    │  INSERT: status='pending', gateway_response={}
│  (pending)       │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Gateway Response │  UPDATE: status='success', gateway_response={...}
│  (success)       │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│application_      │  INSERT: status='active', expiry_date, auto_renew
│subscriptions     │
└────────┬─────────┘
         │
         ├─────────────────┐
         ▼                 ▼
┌──────────────────┐  ┌──────────────────┐
│subscription_     │  │  transactions    │  UPDATE: subscription_id
│renewal           │  │                  │
│(credits)         │  └──────────────────┘
└──────────────────┘
         │
         ▼
┌──────────────────┐
│users & urdd      │  UPDATE: status='active'
│(activation)      │
└──────────────────┘
         │
         ▼
┌──────────────────┐
│user_role_        │  INSERT: Permission assignments
│designation_      │
│permissions       │
└──────────────────┘
```

### Table Relationships

```js
// Foreign Key Relationships
transactions.subscription_id → application_subscriptions.id
transactions.user_payment_method_id → user_payment_methods.id
transactions.plan_id → plans.id
application_subscriptions.urdd_id → user_roles_designations_department.user_role_designation_department_id
subscription_renewal.subscription_id → application_subscriptions.id
subscription_renewal.transaction_id → transactions.id
user_payment_methods.supported_payment_method_id → supported_payment_methods.id
```

### Important Notes

- **Transaction as Source of Truth**: The `transactions` table maintains the complete audit trail of all payment attempts, including gateway responses stored as JSON.
- **Credit Tracking**: Credits are tracked separately in `subscription_renewal` with their own expiry dates, independent of subscription expiry.
- **Gateway Data**: Gateway-specific identifiers (payment_intent_id, subscription_id) are stored in `gateway_response` JSON for future operations.

## Shared Services

### PaymentTransactionService

Manages transaction lifecycle:
- Creates pending transactions
- Updates transaction status
- Handles free plan transactions
- Orchestrates post-payment processing

### SubscriptionService

Manages subscription creation:
- Calculates expiry dates based on plan duration (monthly/yearly/one-time)
- Sets auto-renewal flags
- Creates active subscription records

### CreditsService

Handles credit allocation:
- Allocates credits based on plan configuration
- Sets credit expiry dates
- Assigns plan-specific permissions

### UserActivationService

Manages user activation and permissions:
- Activates user and URDD status
- Assigns plan-specific permissions
- Handles upgrade/downgrade logic
- Creates AI Credits tenant (if applicable)

## Customization

- **Extend Base Class**: Override methods in `PaymentGatewayBase` for custom behavior.
- **Custom Post-Payment Logic**: Extend shared services or add custom logic in gateway implementations.
- **Gateway-Specific Features**: Implement gateway-specific methods for advanced features.
- **Transaction Metadata**: Store gateway-specific data in `gateway_response` JSON field.

## Development Best Practices

- **Keep Gateway Code Focused**: Gateway implementations should only handle gateway-specific API calls. Business logic belongs in shared services.
- **Use Shared Services**: Always use `PaymentTransactionService`, `SubscriptionService`, `CreditsService`, and `UserActivationService` for business logic.
- **Implement Proper Error Handling**: Wrap gateway API calls in try-catch and return normalized error responses.
- **Store Gateway Identifiers**: Store gateway-specific IDs in `gateway_response` for future operations.
- **Handle Idempotency**: Implement duplicate payment prevention and idempotent post-processing.
- **Normalize Responses**: Always return responses in the normalized format expected by the base class.
- **Use Connection Manager**: Always use `PaymentConnectionManager` for database operations to ensure proper connection handling.

## Installation

The Payments module is included in the main UBS Framework project. To use it:

1. **Install Dependencies**: Ensure payment gateway SDKs are installed:
   ```bash
   npm install stripe
   ```

2. **Configure Environment Variables**: Set gateway credentials in `.env`:
   ```env
   STRIPE_SECRET_KEY=sk_test_...
   CHASE_BANK_API_LOGIN_ID=...
   KUICKPAY_INSTITUTION_ID=...
   ```

3. **Start Server**: The payments module is automatically available when the server starts.

## License

MIT
