# UBS Socket Framework Intro

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Socket Service Architecture](#socket-service-architecture)
- [Delegate Structure](#delegate-structure)
- [Socket Event Registration](#socket-event-registration)
- [Usage](#usage)
- [Directory Structure](#directory-structure)
- [Customization](#customization)
- [Development Best Practices](#development-best-practices)
- [Installation](#installation)
- [License](#license)

## Overview

The UBS Socket Framework provides a modular, scalable, and easy-to-use structure for building real-time features in Node.js projects. It abstracts socket.io setup, event registration, and error handling, allowing developers to focus on business logic rather than boilerplate.

### Key Objectives:
- Centralize socket service creation and event registration.
- Decouple event logic from socket server setup.
- Enable easy addition of new socket modules (e.g., chat, quiz, lab).
- Provide global access to socket services for use in any part of the codebase.

## Features

- **Centralized Socket Management**: Create and register socket services by logical name.
- **Delegate-Based Event Handling**: Define event handlers in controller classes.
- **Automatic Context Binding**: Ensures `this` is always correct in event handlers.
- **Global Access**: Retrieve any socket service anywhere using `getSocketService('serviceName')`.
- **Error Isolation**: All event handlers are wrapped in try-catch for robust error handling.
- **Room and Broadcast Utilities**: Easily emit events to rooms, individual sockets, or broadcast.

## Socket Service Architecture

### Initialization Flow

1. **Service Creation**: Use `createSocketService` to instantiate a socket service (e.g., for `/chatbot-socket`).
2. **Delegate Instantiation**: Create a controller (e.g., `ChatBotController`) that defines event handlers.
3. **Binding**: Call `service.initializeDelegate(controller)` to bind the controller to the service.
4. **Event Registration**: The service automatically registers all event handlers from the delegate.
5. **Global Registry**: Each service is registered by logical name for global access.

### Runtime Flow

1. **Client Connection**: A client connects to the socket namespace (e.g., `/chatbot-socket`).
2. **Delegate Handling**: The service calls `delegate.onClientConnected(socket)` for custom connection logic.
3. **Event Trigger**: Client emits an event (e.g., `send_message`).
4. **Routing**: The service routes the event to the corresponding handler in the delegate.
5. **Response**: Use `this.emit()` or `this.toRoom()` in the delegate to send data back to clients.

## Delegate Structure

Each socket module/controller extends `BaseSocketDelegate` and implements:

- `EventHandlers()`: Returns a map of event names to handler functions.
- Optional lifecycle methods: `onClientConnected`, `onClientDisconnected`, `onClientError`.

Example:

```js
class ChatBotController extends BaseSocketDelegate {
  EventHandlers() {
    return {
      'send_message': this.handleSendMessage,
      'get_history': this.handleGetHistory,
      // ...other events
    };
  }

  async handleSendMessage(socket, data) {
    // Example: echo message back to sender and broadcast to room
    this.emit(socket, 'bot_reply', { message: `Echo: ${data.message}` });
    if (data.roomId) {
      this.toRoom(data.roomId, 'new_message', { user: socket.id, message: data.message });
    }
  }
   async handleGetHistory(socket, data) {
    // Example: return static history
    const history = [
      { user: 'bot', message: 'Welcome to the chatbot!' },
      { user: 'user1', message: 'Hello!' }
    ];
    this.emit(socket, 'chat_history', { history });
  }
```

## Socket Event Registration

To add a new socket module:

1. **Create a Controller**: Extend `BaseSocketDelegate` and define your event handlers.
2. **Register the Service**: In `RegisterDelegates.js`, create and initialize the service:

```js
const { createSocketService } = require('.../SocketRegistration');
const MyController = require('./Controllers/MyController');

const myConfig = { path: '/my-socket' };
const mySocketService = createSocketService(myConfig, 'my');
mySocketService.initializeDelegate(new MyController());
```

3. **Access Anywhere**: Use `getSocketService('my')` to emit events from any part of your codebase.

## Usage

- **Emit to Room**: `getSocketService('chat').emitToRoom(roomId, 'new-query', payload);`
- **Emit to Socket**: `this.emit(socket, 'event-name', payload);`
- **Broadcast**: `this.broadcast('event-name', payload);`
- **Handle Connection**: Override `onClientConnected(socket)` in your delegate for custom logic

## Directory Structure

```
Services/
├── Integrations/
│   └── Socket/
│       ├── BaseSocketDelegate.js
│       ├── SocketService.js
│       ├── SocketRegistration.js

Src/
├── Sockets/
│   ├── RegisterDelegates.js
│       └── Controllers/
│           ├── QuizController/
│           └── LabController/```

## Customization

- **Add Middleware**: Pass middleware functions in the service config.
- **Extend Delegates**: Add custom event handlers and lifecycle methods.
- **Global Access**: Use the registry to access any socket service anywhere.

## Development Best Practices

- **Keep business logic in delegates/controllers.**
- **Use try-catch in event handlers for robust error handling.**
- **Emit events using provided utility methods for consistency.**
- **Register all socket services in `RegisterDelegates.js` for clarity.**
- **Use logical names for services to simplify global access.**

## Installation

1. Clone the repository:
   ```bash
   git clone <repository_url>
   cd <project_folder>
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure your server and socket paths in `.env` and `RegisterDelegates.js`.
4. Start the server:
   ```bash
   npm start
   ```

## License

MIT	