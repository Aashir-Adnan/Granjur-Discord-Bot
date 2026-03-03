# Frequently Asked Questions

This page answers the most common questions when working with **UBS Framework**, including API structure, running the server, encryption, preprocess functions, and more.

---

## How do I call an API?

An API is called by hitting a UBS-generated URL:

```text
http://[base-url]:[port]/api/[constructed-api-url]
````

**Example:**

```text
http://localhost:3000/api/example/api/structure
```

### How the URL is constructed

If your API object is declared like this:

```js
global.ExampleApiStructure_object = {}
```

UBS automatically creates its route by:

1. Taking the object name before the `_`
2. Splitting it into words: `Example Api Structure`
3. Converting it into a lowercase path with slashes:

```text
example/api/structure
```

This means:

```text
global.YourCustomApi_object → /api/your/custom/api
```

---

## How do I access documentation?

All UBS documentation is stored in two places:

* **Google Drive (official reference):**
  [https://drive.google.com/drive/folders/1efkNvEoj3ooRa_ieXooe7hUQXLRVieje?usp=sharing](https://drive.google.com/drive/folders/1efkNvEoj3ooRa_ieXooe7hUQXLRVieje?usp=sharing)

* **This website (Docusaurus documentation)**
  All UBS guides, FAQs, and technical references.

---

## How do I run the server?

Run the following:

```bash
npm i     # install dependencies
npm run start
```

This starts the UBS server with all defined APIs and global objects loaded.

---

## How do I add a new API?

To add an API:

1. Create a **global object** in the naming format described in
   [`UBS Intro`](/docs/backend/UBS-intro)

Example:

```js
global.UserLogin_object = {
  query: "...",
  config: { ... }
};
```

2. UBS automatically exposes it at:

```text
/api/user/login
```

3. Add preprocess, postprocess, query functions, and flags as needed.

---

## How is a URL constructed in UBS Framework?

UBS converts API object names into REST-style routes:

```text
global.SampleThing_object → /api/sample/thing
```

Rule:
**ObjectNameBeforeUnderscore → split by capital letters → join with slashes → lowercase**

---

## How do preprocess functions work?

Preprocess functions run **before the main query**, after core config functions.

Example:

```js
PreProcessFunctions: [func1, func2]
```

### Behavior

Each function runs sequentially and must be **async**.

Their results are stored inside:

```js
decryptedPayload[functionName]
```

Example:

```js
async function add(num1, num2) {
  return num1 + num2;
}
```

Result available as:

```js
decryptedPayload.add
```

### Recommended uses

* validating data
* enriching payload
* generating tokens
* calling other APIs
* adding system metadata

---

## How does the post-process function work?

The post-process function runs:

**after query execution but before sending the response.**

```js
PostProcessFunction: async function format(result) {
  return { cleaned: result };
}
```

UBS sends:

```js
response.return = <value of postprocess>
```

Useful for:

* formatting SQL results
* removing internal fields
* structuring API responses

---

## How does the QueryPayload function work?

Use this when your SQL query depends on dynamic payload values.

Example:

```js
QueryPayload: async (req, decryptedPayload) => {
  return `
    SELECT * FROM users
    WHERE id = {{userId}}
  `;
}
```

### How placeholders work

* `{{attribute}}` → replaced with value from `decryptedPayload.attribute`
* If the attribute is an **array**, UBS runs the query once for each value
  *(only one array attribute allowed per query)*

This allows dynamic:

* filtering
* batch operations
* conditional SQL building

---

## What are the prerequisites for running the server?

You need:

* Node.js installed
* `npm i` completed
* The **core CRUD objects** available
* Proper folder structure in place (`/api`, `/objects`, `/config`, etc.)

---

## How do I enable or disable encryption?

Set the following inside your API object:

### Encrypted + Requires Login

```js
config: {
  communication: {
    encryption: {
      platformEncryption: true,
      accessToken: true
    }
  }
}
```

### Encrypted but Public API

```js
config: {
  communication: {
    encryption: {
      platformEncryption: true
    }
  }
}
```

### No encryption (plaintext)

```js
config: {
  communication: {
    encryption: false
  }
}
```

Use this only for testing.

---