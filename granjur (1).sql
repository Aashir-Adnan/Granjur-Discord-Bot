-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Jul 17, 2026 at 07:55 AM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.0.30

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `granjur`
--

-- --------------------------------------------------------

--
-- Table structure for table `bugticketcomment`
--

CREATE TABLE `bugticketcomment` (
  `id` varchar(36) NOT NULL,
  `authorId` varchar(64) NOT NULL,
  `authorTag` varchar(255) DEFAULT NULL,
  `content` text NOT NULL,
  `attachmentUrls` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`attachmentUrls`)),
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `taskId` varchar(36) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `clockentry`
--

CREATE TABLE `clockentry` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `discordId` varchar(64) NOT NULL,
  `clockInAt` datetime(3) NOT NULL,
  `clockOutAt` datetime(3) DEFAULT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `dump_versions`
--

CREATE TABLE `dump_versions` (
  `id` varchar(36) NOT NULL,
  `project_schema_id` varchar(36) NOT NULL,
  `content` longtext NOT NULL,
  `created_at` datetime(3) DEFAULT current_timestamp(3),
  `created_by` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `dump_versions`
--

INSERT INTO `dump_versions` (`id`, `project_schema_id`, `content`, `created_at`, `created_by`) VALUES
('015a5e508e6d466ea925b27d8', '58f01453f93b474b8c5ae52ff', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:14.604', 'seed@granjur.com'),
('0cb7686220b245c1a1821f2fb', 'c9a108e46c7b4658bbb99278f', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:14.590', 'seed@granjur.com'),
('17b7e7dda857426e82670ad97', '44734ae1b487479995dd25d7c', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:14.622', 'seed@granjur.com'),
('1ea1c631264843bba0e834c0f', '0a7ab08e110c4462b033fdcc2', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-03 07:38:47.866', 'seed@granjur.com'),
('234df7b973164d71a74a71dc8', 'cb640a5aa455462da56a49998', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:14.632', 'seed@granjur.com'),
('256a3c2798974435afa2c86e5', '46c7bc58546a440e81c4b6afc', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-03 07:38:47.857', 'seed@granjur.com'),
('2a97fa3d52704240ad5aacade', '9d834464e3054b3b932439875', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:14.618', 'seed@granjur.com'),
('2b84011f642d42f98e25f86d8', '58f01453f93b474b8c5ae52ff', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:31.168', 'seed@granjur.com'),
('2d49e86ac15e4297944f8d768', '8ca2d3b723144d549a5944bd2', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:31.165', 'seed@granjur.com'),
('4c16b75037cf42fdb96fa3f97', '2735e70e3ff746169ced3334a', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-03 07:38:47.871', 'seed@granjur.com'),
('4d77e4251d674f83865ad2601', '9d834464e3054b3b932439875', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:31.175', 'seed@granjur.com'),
('5a1ff49364f044628045bbf24', '3b6594f25c57405abab35ad37', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:31.172', 'seed@granjur.com'),
('5d54a4b62bd2437695410d178', '3656f0f18fb04782bc865b12e', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-03 07:38:47.868', 'seed@granjur.com'),
('68232d9ed86848c68f9c1409d', '0f24c7bac10746079f2723b58', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:31.179', 'seed@granjur.com'),
('6a1765e11dcb4a63ac0e133e8', '8ca2d3b723144d549a5944bd2', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:14.599', 'seed@granjur.com'),
('7412351ef96a4fdf8fbc91efa', '6f8d11ca44da4795b3041af7a', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-03 07:38:47.864', 'seed@granjur.com'),
('7f9c488b98394950a89fb887e', '90fc516eb9a34c8c907f4b926', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-03 07:38:47.870', 'seed@granjur.com'),
('8a6c4c59764a40aa9a58b8ea2', 'c9a108e46c7b4658bbb99278f', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:31.162', 'seed@granjur.com'),
('aaf1299a9bce4682ba058405c', 'cb640a5aa455462da56a49998', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:31.181', 'seed@granjur.com'),
('cab2d954c401440dbe134acb4', '44734ae1b487479995dd25d7c', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:31.177', 'seed@granjur.com'),
('e61af7fd7ed24804867d8903b', '3e84691c2dcc4324aaa5e6265', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-03 07:38:47.859', 'seed@granjur.com'),
('e8b126033c7b4d648a1b8e631', '3b6594f25c57405abab35ad37', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:14.614', 'seed@granjur.com'),
('f1d584b4f7ec41c7926882c30', '490c79184b3342928b9b26ddb', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-03 07:38:47.873', 'seed@granjur.com'),
('fa0ddfc8bf0740538fd8dd83c', '0f24c7bac10746079f2723b58', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '2026-03-05 12:46:14.627', 'seed@granjur.com');

-- --------------------------------------------------------

--
-- Table structure for table `email_log`
--

CREATE TABLE `email_log` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) DEFAULT NULL,
  `recipient_email` varchar(255) NOT NULL,
  `subject` varchar(512) DEFAULT NULL,
  `content` text DEFAULT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `email_log`
--

INSERT INTO `email_log` (`id`, `guildConfigId`, `recipient_email`, `subject`, `content`, `createdAt`) VALUES
('58314b3323bb4493941a847da', '471aee71717945e493b253de7', 'aashir@granjur.com', 'You\'re invited to Granjur', '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <style>\n    body { font-family: Arial, sans-serif; background-color: #f9f9f9; color: #333; margin: 0; padding: 0; }\n    .container { padding: 20px; background: #fff; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 30px auto; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }\n    h2 { color: #5865f2; margin-bottom: 20px; }\n    p { line-height: 1.6; margin-bottom: 15px; }\n    a.btn { display: inline-block; padding: 12px 24px; background: #5865f2; color: #fff; text-decoration: none; border-radius: 6px; margin: 10px 0; }\n    .footer { font-size: 12px; color: #888; margin-top: 20px; text-align: center; }\n  </style>\n</head>\n<body>\n  <div class=\"container\">\n    <h2>You\'re invited to Granjur</h2>\n    <p>Click the link below to join the server on Discord:</p>\n    <p><a href=\"https://discord.gg/Vvf23c8\" class=\"btn\">Join server</a></p>\n    <p>Or copy this link: https://discord.gg/Vvf23c8</p>\n    <div class=\"footer\">Granjur • This invite was sent to an @granjur.com address.</div>\n  </div>\n</body>\n</html>', '2026-03-03 08:21:34.776'),
('5948673d273d447ea072c7808', '471aee71717945e493b253de7', 'aashir@granjur.com', 'You\'re invited to Granjur', '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <style>\n    body { font-family: Arial, sans-serif; background-color: #f9f9f9; color: #333; margin: 0; padding: 0; }\n    .container { padding: 20px; background: #fff; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 30px auto; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }\n    h2 { color: #5865f2; margin-bottom: 20px; }\n    p { line-height: 1.6; margin-bottom: 15px; }\n    a.btn { display: inline-block; padding: 12px 24px; background: #5865f2; color: #fff; text-decoration: none; border-radius: 6px; margin: 10px 0; }\n    .footer { font-size: 12px; color: #888; margin-top: 20px; text-align: center; }\n  </style>\n</head>\n<body>\n  <div class=\"container\">\n    <h2>You\'re invited to Granjur</h2>\n    <p>Click the link below to join the server on Discord:</p>\n    <p><a href=\"https://discord.gg/CFBmjYN\" class=\"btn\">Join server</a></p>\n    <p>Or copy this link: https://discord.gg/CFBmjYN</p>\n    <div class=\"footer\">Granjur • This invite was sent to an @granjur.com address.</div>\n  </div>\n</body>\n</html>', '2026-03-03 08:09:25.253'),
('6ae88407ea224d4296646a18e', '471aee71717945e493b253de7', 'muhammad.raza@granjur.com', 'You\'re invited to Granjur', '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <style>\n    body { font-family: Arial, sans-serif; background-color: #f9f9f9; color: #333; margin: 0; padding: 0; }\n    .container { padding: 20px; background: #fff; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 30px auto; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }\n    h2 { color: #5865f2; margin-bottom: 20px; }\n    p { line-height: 1.6; margin-bottom: 15px; }\n    a.btn { display: inline-block; padding: 12px 24px; background: #5865f2; color: #fff; text-decoration: none; border-radius: 6px; margin: 10px 0; }\n    .footer { font-size: 12px; color: #888; margin-top: 20px; text-align: center; }\n  </style>\n</head>\n<body>\n  <div class=\"container\">\n    <h2>You\'re invited to Granjur</h2>\n    <p>Click the link below to join the server on Discord:</p>\n    <p><a href=\"https://discord.gg/hCN6m59\" class=\"btn\">Join server</a></p>\n    <p>Or copy this link: https://discord.gg/hCN6m59</p>\n    <div class=\"footer\">Granjur • This invite was sent to an @granjur.com address.</div>\n  </div>\n</body>\n</html>', '2026-03-05 11:39:50.598'),
('be53e20df0484f458c9012e16', '471aee71717945e493b253de7', 'afaq.khawar@granjur.com', 'You\'re invited to Granjur', '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <style>\n    body { font-family: Arial, sans-serif; background-color: #f9f9f9; color: #333; margin: 0; padding: 0; }\n    .container { padding: 20px; background: #fff; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 30px auto; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }\n    h2 { color: #5865f2; margin-bottom: 20px; }\n    p { line-height: 1.6; margin-bottom: 15px; }\n    a.btn { display: inline-block; padding: 12px 24px; background: #5865f2; color: #fff; text-decoration: none; border-radius: 6px; margin: 10px 0; }\n    .footer { font-size: 12px; color: #888; margin-top: 20px; text-align: center; }\n  </style>\n</head>\n<body>\n  <div class=\"container\">\n    <h2>You\'re invited to Granjur</h2>\n    <p>Click the link below to join the server on Discord:</p>\n    <p><a href=\"https://discord.gg/hCN6m59\" class=\"btn\">Join server</a></p>\n    <p>Or copy this link: https://discord.gg/hCN6m59</p>\n    <div class=\"footer\">Granjur • This invite was sent to an @granjur.com address.</div>\n  </div>\n</body>\n</html>', '2026-03-05 11:39:45.647'),
('e89a7ba508014791bd20baca8', '471aee71717945e493b253de7', 'aashir@granjur.com', 'You\'re invited to Granjur', '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <style>\n    body { font-family: Arial, sans-serif; background-color: #f9f9f9; color: #333; margin: 0; padding: 0; }\n    .container { padding: 20px; background: #fff; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 30px auto; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }\n    h2 { color: #5865f2; margin-bottom: 20px; }\n    p { line-height: 1.6; margin-bottom: 15px; }\n    a.btn { display: inline-block; padding: 12px 24px; background: #5865f2; color: #fff; text-decoration: none; border-radius: 6px; margin: 10px 0; }\n    .footer { font-size: 12px; color: #888; margin-top: 20px; text-align: center; }\n  </style>\n</head>\n<body>\n  <div class=\"container\">\n    <h2>You\'re invited to Granjur</h2>\n    <p>Click the link below to join the server on Discord:</p>\n    <p><a href=\"https://discord.gg/hvnE8Wq\" class=\"btn\">Join server</a></p>\n    <p>Or copy this link: https://discord.gg/hvnE8Wq</p>\n    <div class=\"footer\">Granjur • This invite was sent to an @granjur.com address.</div>\n  </div>\n</body>\n</html>', '2026-03-03 08:49:21.311'),
('f34f039877e04cacb097c6c41', '471aee71717945e493b253de7', 'aashir@granjur.com', 'Your Granjur verification code', '<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"></head>\n<body style=\"font-family: Arial, sans-serif; padding: 20px;\">\n  <h2>Your verification code</h2>\n  <p><strong>649507</strong></p>\n  <p>This code expires in 10 minutes. Use it in Discord to verify your email.</p>\n  <p class=\"footer\" style=\"color:#888;font-size:12px;\">Granjur verification</p>\n</body>\n</html>', '2026-03-03 08:29:18.977');

-- --------------------------------------------------------

--
-- Table structure for table `faq`
--

CREATE TABLE `faq` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `repositoryId` varchar(36) DEFAULT NULL,
  `question` text NOT NULL,
  `answer` text DEFAULT NULL,
  `askedBy` varchar(64) NOT NULL,
  `answeredBy` varchar(64) DEFAULT NULL,
  `answeredAt` datetime(3) DEFAULT NULL,
  `status` varchar(32) DEFAULT 'open',
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `feature_project_schemas`
--

CREATE TABLE `feature_project_schemas` (
  `project_schema_id` varchar(36) NOT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `task_id` varchar(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `feature_repositories`
--

CREATE TABLE `feature_repositories` (
  `repository_id` varchar(36) NOT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `task_id` varchar(36) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `feature_repositories`
--

INSERT INTO `feature_repositories` (`repository_id`, `createdAt`, `task_id`) VALUES
('732e0856c55145b9be82c9101', '2026-03-03 10:30:58.810', '0f13a1a708d945cea1e516431'),
('732e0856c55145b9be82c9101', '2026-03-03 11:40:22.756', '70aa15b8d28a4853a73c6a421');

-- --------------------------------------------------------

--
-- Table structure for table `guildconfig`
--

CREATE TABLE `guildconfig` (
  `id` varchar(36) NOT NULL,
  `guildId` varchar(64) NOT NULL,
  `onboardingChannelId` varchar(64) DEFAULT NULL,
  `holdingRoleId` varchar(64) DEFAULT NULL,
  `verifiedRoleId` varchar(64) DEFAULT NULL,
  `adminChannelId` varchar(64) DEFAULT NULL,
  `allowedDomains` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '["granjur.com"]' CHECK (json_valid(`allowedDomains`)),
  `dashboardRoleIds` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`dashboardRoleIds`)),
  `seniorRoleIds` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`seniorRoleIds`)),
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3),
  `clockedInRoleId` varchar(64) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `guildconfig`
--

INSERT INTO `guildconfig` (`id`, `guildId`, `onboardingChannelId`, `holdingRoleId`, `verifiedRoleId`, `adminChannelId`, `allowedDomains`, `dashboardRoleIds`, `seniorRoleIds`, `createdAt`, `updatedAt`, `clockedInRoleId`) VALUES
('27f45a18a74d4bfc96d784adf', '000000000000000001', NULL, NULL, NULL, NULL, '[\"granjur.com\"]', '[]', '[]', '2026-03-03 07:38:47.806', '2026-03-03 07:38:47.806', NULL),
('471aee71717945e493b253de7', '1476079072584138825', '1478217026550890627', '1478217028606365819', '1478217030913228870', '1478217197162856600', '[\"granjur.com\"]', '[\"1478217073040822446\",\"1478217070935281697\"]', '[\"1478217073040822446\",\"1478217070935281697\",\"1478217055957286983\"]', '2026-03-03 07:30:21.069', '2026-03-03 13:07:44.080', '1478302837493600351');

-- --------------------------------------------------------

--
-- Table structure for table `guildmember`
--

CREATE TABLE `guildmember` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `discordId` varchar(64) NOT NULL,
  `email` varchar(255) DEFAULT NULL,
  `verifiedAt` datetime(3) DEFAULT NULL,
  `status` varchar(32) DEFAULT 'pending',
  `roleIds` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`roleIds`)),
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `guildmember`
--

INSERT INTO `guildmember` (`id`, `guildConfigId`, `discordId`, `email`, `verifiedAt`, `status`, `roleIds`, `createdAt`, `updatedAt`) VALUES
('08408799ae324f2d9ce51e043', '471aee71717945e493b253de7', '1479046228959559700', NULL, NULL, 'pending', '[]', '2026-07-17 05:20:07.414', '2026-07-17 05:20:07.414'),
('35b2e7555c314d17b054ff6a5', '471aee71717945e493b253de7', '1527227729508962336', NULL, NULL, 'pending', '[]', '2026-07-17 05:20:09.769', '2026-07-17 05:20:09.769'),
('4774c7c2d8b342b692430169f', '471aee71717945e493b253de7', '1523115441315254312', NULL, NULL, 'pending', '[]', '2026-07-17 05:20:09.388', '2026-07-17 05:20:09.388'),
('4a500a35768a4b58ad1eca399', '471aee71717945e493b253de7', '1262267293727985696', NULL, NULL, 'pending', '[]', '2026-07-17 05:20:06.957', '2026-07-17 05:20:06.957'),
('dd742435f07c4a8b901239293', '471aee71717945e493b253de7', '545956110272692234', NULL, '2026-07-17 05:22:23.632', 'approved', '[\"Server Manager\",\"Associate Engineer\",\"Database\",\"Full-Stack\",\"Server\"]', '2026-07-17 05:20:06.602', '2026-07-17 05:23:36.784'),
('fcecca868e6146759a08f5f21', '471aee71717945e493b253de7', '1476450967548596385', NULL, '2026-03-03 09:01:04.452', 'approved', '[\"Associate Engineer\",\"Database\"]', '2026-03-03 08:10:34.532', '2026-03-03 09:25:39.366');

-- --------------------------------------------------------

--
-- Table structure for table `guild_assignable_roles`
--

CREATE TABLE `guild_assignable_roles` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `guild_assignable_roles`
--

INSERT INTO `guild_assignable_roles` (`id`, `guildConfigId`, `name`, `createdAt`) VALUES
('155bd63aa2ff40079f707d6b5', '471aee71717945e493b253de7', 'Designer', '2026-03-03 09:19:33.182'),
('29107e266c8f47b185454e7cf', '471aee71717945e493b253de7', 'Server Manager', '2026-03-03 09:19:33.170'),
('320247a212ab4c90b5fa0055e', '471aee71717945e493b253de7', 'Project Manager', '2026-03-03 09:19:33.168'),
('321640efc5c24e5d8a9e1cd17', '471aee71717945e493b253de7', 'Frontend', '2026-03-03 09:19:33.175'),
('347648aafabe449f9a46915d8', '471aee71717945e493b253de7', 'Server', '2026-03-03 09:19:33.183'),
('42e0a864f9194076991125f3c', '471aee71717945e493b253de7', 'Junior Dev', '2026-03-03 09:19:33.154'),
('6356cd2422e3426fb57ffc855', '471aee71717945e493b253de7', 'Database', '2026-03-03 09:19:33.187'),
('6567ae56902a43f4816be3e29', '471aee71717945e493b253de7', 'Temp', '2026-03-03 09:19:33.150'),
('7f68ce1b48784b6b9100b0492', '471aee71717945e493b253de7', 'Full-Stack', '2026-03-03 09:19:33.185'),
('87223d1a234c4b879bb7bb3d0', '471aee71717945e493b253de7', 'Intern', '2026-03-03 09:19:33.145'),
('96b43de0ecfa47438e475294d', '471aee71717945e493b253de7', 'Associate Engineer', '2026-03-03 09:19:33.158'),
('97d32e18dad844a8ae35f20d6', '471aee71717945e493b253de7', 'Senior Dev', '2026-03-03 09:19:33.156'),
('a5b03acbd28246c0b01a2f353', '471aee71717945e493b253de7', 'UI/UX', '2026-03-03 09:19:33.179'),
('b77bffd1b5894fd48996cec8e', '471aee71717945e493b253de7', 'Quality Assurance', '2026-03-03 09:19:33.163'),
('d3933cd86bc341a1ba2d1add8', '471aee71717945e493b253de7', 'CEO', '2026-03-03 09:19:33.172');

-- --------------------------------------------------------

--
-- Table structure for table `guild_modules`
--

CREATE TABLE `guild_modules` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `guild_modules`
--

INSERT INTO `guild_modules` (`id`, `guildConfigId`, `name`, `createdAt`) VALUES
('136ef711577e48aa9f3219e8d', '471aee71717945e493b253de7', 'Startup Scripts', '2026-03-03 13:27:02.847'),
('1b696aa2704349ccb5a325e0b', '471aee71717945e493b253de7', 'Design', '2026-03-03 14:49:18.691'),
('3dcb3292dd22470d86c5333a6', '471aee71717945e493b253de7', 'Project Generation', '2026-03-03 11:38:34.715'),
('998c1f8be3994d3c9939c1a1c', '471aee71717945e493b253de7', 'Startup Script', '2026-03-03 13:22:37.280'),
('c10fb1fdfe734e7f9cacc0b58', '471aee71717945e493b253de7', 'Create Project', '2026-03-05 11:42:40.589'),
('db13a832547b4025b1331aa98', '471aee71717945e493b253de7', 'Functionality', '2026-03-03 14:49:18.677'),
('dbaf05ddb1b14842b4f77ece0', '471aee71717945e493b253de7', 'Project Creation', '2026-03-03 10:03:43.198');

-- --------------------------------------------------------

--
-- Table structure for table `guild_scopes`
--

CREATE TABLE `guild_scopes` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `meeting`
--

CREATE TABLE `meeting` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `channelId` varchar(64) NOT NULL,
  `externalId` varchar(255) DEFAULT NULL,
  `transcript` text DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `projectId` varchar(255) DEFAULT NULL,
  `repositoryUrl` varchar(512) DEFAULT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `meetingchannel`
--

CREATE TABLE `meetingchannel` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `voiceChannelId` varchar(64) NOT NULL,
  `textChannelId` varchar(64) DEFAULT NULL,
  `meetingId` varchar(36) DEFAULT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `pendinginvite`
--

CREATE TABLE `pendinginvite` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `inviteCode` varchar(32) NOT NULL,
  `email` varchar(255) NOT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `pendinginvite`
--

INSERT INTO `pendinginvite` (`id`, `guildConfigId`, `inviteCode`, `email`, `createdAt`) VALUES
('05c4b9eccc6c4cf79a6619d4b', '471aee71717945e493b253de7', 'hvnE8Wq', 'aashir@granjur.com', '2026-03-03 08:49:18.897'),
('73e7f0bc88354488b1074327c', '471aee71717945e493b253de7', 'hCN6m59', 'muhammad.raza@granjur.com', '2026-03-05 11:39:47.834'),
('9ed1aef9b58e478aa6845feee', '471aee71717945e493b253de7', 'hCN6m59', 'afaq.khawar@granjur.com', '2026-03-05 11:39:41.347');

-- --------------------------------------------------------

--
-- Table structure for table `project`
--

CREATE TABLE `project` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `readme` text DEFAULT NULL,
  `owner_emails` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`owner_emails`)),
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `project`
--

INSERT INTO `project` (`id`, `guildConfigId`, `name`, `readme`, `owner_emails`, `createdAt`, `updatedAt`) VALUES
('04c1b2d9cc174a19b8a885b6f', '27f45a18a74d4bfc96d784adf', 'Badar HMS', '# Badar HMS\nHospital management system.', '[\"admin@granjur.com\"]', '2026-03-05 12:46:14.518', '2026-03-05 12:46:14.518'),
('080ad90c377a4aca80fb7cf2f', '27f45a18a74d4bfc96d784adf', 'Fittour', '# Fittour\nDummy readme for testing.', '[\"aashir@granjur.com\",\"dev@granjur.com\"]', '2026-03-05 12:46:14.505', '2026-03-05 12:46:14.505'),
('0affd53d4e2845e5a2cd1c135', '27f45a18a74d4bfc96d784adf', 'UBS-Doc', '# UBS Doc\nDocumentation site (Docusaurus).', '[\"aashir@granjur.com\"]', '2026-03-05 12:46:14.515', '2026-03-05 12:46:14.515'),
('0b3ffac8192140f0a56ed07f7', '27f45a18a74d4bfc96d784adf', 'Edarete', '# Edarete\nProject documentation.', '[\"aashir@granjur.com\"]', '2026-03-05 12:46:14.510', '2026-03-05 12:46:14.510'),
('0d3a848b6eba4868afdfbbed4', '471aee71717945e493b253de7', 'ScholarSpace', '# ScholarSpace\nAPI middleware architecture.', '[\"aashir@granjur.com\"]', '2026-03-03 07:38:47.839', '2026-03-03 07:40:59.798'),
('32f4cc290f5c427e87a0429ab', '471aee71717945e493b253de7', 'Fittour', '# Fittour\nDummy readme for testing.', '[\"aashir@granjur.com\",\"dev@granjur.com\"]', '2026-03-03 07:38:47.832', '2026-03-03 07:40:59.798'),
('4cec4a3558974153b311c62eb', '471aee71717945e493b253de7', 'Edarete', '# Edarete\nProject documentation.', '[\"aashir@granjur.com\"]', '2026-03-03 07:38:47.836', '2026-03-03 07:40:59.798'),
('505f2dfc54634b2581bb2c4b1', '27f45a18a74d4bfc96d784adf', 'Ilmversity', '# Ilmversity\nAI credits backend.', '[\"support@granjur.com\"]', '2026-03-05 12:46:14.522', '2026-03-05 12:46:14.522'),
('613093a360754771bff9110a2', '471aee71717945e493b253de7', 'UBS-Doc', '# UBS Doc\nDocumentation site (Docusaurus).', '[\"aashir@granjur.com\"]', '2026-03-03 07:38:47.838', '2026-03-03 07:40:59.798'),
('7cc5e9ef4bc741d19c7231007', '27f45a18a74d4bfc96d784adf', 'CSAAS', '# CSAAS Backend\nDummy project.', '[\"dev@granjur.com\"]', '2026-03-05 12:46:14.520', '2026-03-05 12:46:14.520'),
('7de1171a92184d47bb22e3167', '27f45a18a74d4bfc96d784adf', 'ScholarSpace', '# ScholarSpace\nAPI middleware architecture.', '[\"aashir@granjur.com\"]', '2026-03-05 12:46:14.516', '2026-03-05 12:46:14.516'),
('a1952da3e5054e68b0ce66163', '471aee71717945e493b253de7', 'Ilmversity', '# Ilmversity\nAI credits backend.', '[\"support@granjur.com\"]', '2026-03-03 07:38:47.843', '2026-03-03 07:40:59.798'),
('bce98f55d6134c209ddab0760', '27f45a18a74d4bfc96d784adf', 'Framework', '# UBS Framework\nShared framework.', '[\"team@granjur.com\"]', '2026-03-05 12:46:14.512', '2026-03-05 12:46:14.512'),
('d290f94f1f584ddd903e19248', '471aee71717945e493b253de7', 'Framework', '# UBS Framework\nShared framework.', '[\"team@granjur.com\"]', '2026-03-03 07:38:47.837', '2026-03-03 07:40:59.798'),
('d3067f6c98ea40e8b62054267', '471aee71717945e493b253de7', 'Badar HMS', '# Badar HMS\nHospital management system.', '[\"admin@granjur.com\"]', '2026-03-03 07:38:47.841', '2026-03-03 07:40:59.798'),
('d55d006f467f4b768ebe812e3', '471aee71717945e493b253de7', 'CSAAS', '# CSAAS Backend\nDummy project.', '[\"dev@granjur.com\"]', '2026-03-03 07:38:47.842', '2026-03-03 07:40:59.798');

-- --------------------------------------------------------

--
-- Table structure for table `projectschema`
--

CREATE TABLE `projectschema` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `projectId` varchar(255) NOT NULL,
  `projectName` varchar(255) DEFAULT NULL,
  `schemaContent` text NOT NULL,
  `readme` text DEFAULT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `projectschema`
--

INSERT INTO `projectschema` (`id`, `guildConfigId`, `projectId`, `projectName`, `schemaContent`, `readme`, `createdAt`, `updatedAt`) VALUES
('3a2feae5c80e4df5a17a85f23', '27f45a18a74d4bfc96d784adf', 'framework', 'Framework', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '# Framework\nSeeded README', '2026-03-05 12:46:14.533', '2026-03-05 12:46:14.533'),
('485f2246f27b463b8150251fc', '27f45a18a74d4bfc96d784adf', 'fittour', 'Fittour', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '# Fittour\nSeeded README', '2026-03-05 12:46:14.525', '2026-03-05 12:46:14.525'),
('5d309fcaaa9d4deda9b51e804', '27f45a18a74d4bfc96d784adf', 'badar-hms', 'Badar HMS', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '# Badar HMS\nSeeded README', '2026-03-05 12:46:14.538', '2026-03-05 12:46:14.538'),
('716a567291e348afafb34ca2e', '27f45a18a74d4bfc96d784adf', 'ubs-doc', 'UBS-Doc', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '# UBS-Doc\nSeeded README', '2026-03-05 12:46:14.535', '2026-03-05 12:46:14.535'),
('8902dfc7bfdc453582104844c', '27f45a18a74d4bfc96d784adf', 'csaas', 'CSAAS', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '# CSAAS\nSeeded README', '2026-03-05 12:46:14.542', '2026-03-05 12:46:14.542'),
('a33817a9959a4949b6e5ba25e', '27f45a18a74d4bfc96d784adf', 'scholarspace', 'ScholarSpace', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '# ScholarSpace\nSeeded README', '2026-03-05 12:46:14.537', '2026-03-05 12:46:14.537'),
('a37a12ca12d043a1b5e9cea63', '27f45a18a74d4bfc96d784adf', 'ilmversity', 'Ilmversity', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '# Ilmversity\nSeeded README', '2026-03-05 12:46:14.545', '2026-03-05 12:46:14.545'),
('dd35ca5eb26947f8b652a8725', '27f45a18a74d4bfc96d784adf', 'edarete', 'Edarete', '-- Dummy schema v1\nCREATE TABLE IF NOT EXISTS users (\n  id VARCHAR(36) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\nCREATE TABLE IF NOT EXISTS projects (\n  id VARCHAR(36) PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)\n);\n', '# Edarete\nSeeded README', '2026-03-05 12:46:14.529', '2026-03-05 12:46:14.529');

-- --------------------------------------------------------

--
-- Table structure for table `project_repos`
--

CREATE TABLE `project_repos` (
  `project_id` varchar(36) NOT NULL,
  `repository_id` varchar(36) NOT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `project_repos`
--

INSERT INTO `project_repos` (`project_id`, `repository_id`, `createdAt`) VALUES
('04c1b2d9cc174a19b8a885b6f', 'cbf25c6ceb8640fc8ecd16ff4', '2026-03-05 12:46:14.657'),
('080ad90c377a4aca80fb7cf2f', 'f9902bcaaac9418491ebe2e85', '2026-03-05 12:46:14.661'),
('0affd53d4e2845e5a2cd1c135', 'a7a25b0f3835480bbca95cdd7', '2026-03-05 12:46:14.654'),
('0b3ffac8192140f0a56ed07f7', 'b4cddd56f35e432884f5eedf1', '2026-03-05 12:46:14.641'),
('0b3ffac8192140f0a56ed07f7', 'e26eab13cf7e40a4a4ca428e0', '2026-03-05 12:46:14.651'),
('0d3a848b6eba4868afdfbbed4', 'decef2b5f1d046b4940ab5b19', '2026-03-03 07:38:47.885'),
('32f4cc290f5c427e87a0429ab', 'f246f4425414496a9e8ddd3ad', '2026-03-03 07:38:47.889'),
('4cec4a3558974153b311c62eb', 'cb1ffd9c40b24cd0b08c20566', '2026-03-03 07:38:47.883'),
('4cec4a3558974153b311c62eb', 'd1af282f83cc4d3dada930636', '2026-03-03 07:38:47.882'),
('505f2dfc54634b2581bb2c4b1', 'ec5c88ee60d34cdbb528e246b', '2026-03-05 12:46:14.659'),
('613093a360754771bff9110a2', 'd90f409fbf594a488d3440ee2', '2026-03-03 07:38:47.884'),
('7cc5e9ef4bc741d19c7231007', '3cea873f06f04c4b9a4956fd8', '2026-03-05 12:46:14.658'),
('7de1171a92184d47bb22e3167', 'f6e1e02e59484543937f690ea', '2026-03-05 12:46:14.655'),
('a1952da3e5054e68b0ce66163', '60a945fdce4f449f826b71578', '2026-03-03 07:38:47.888'),
('bce98f55d6134c209ddab0760', '4dcb669636b647b495da936e2', '2026-03-05 12:46:14.639'),
('bce98f55d6134c209ddab0760', 'f276caf1689e43c6a84392150', '2026-03-05 12:46:14.640'),
('bce98f55d6134c209ddab0760', 'f9902bcaaac9418491ebe2e85', '2026-03-05 12:46:14.636'),
('d290f94f1f584ddd903e19248', '4ec1cd0101954a9c8da4c7c07', '2026-03-03 07:38:47.880'),
('d290f94f1f584ddd903e19248', 'a1854e527abd4e80be709fe31', '2026-03-03 07:38:47.880'),
('d290f94f1f584ddd903e19248', 'f246f4425414496a9e8ddd3ad', '2026-03-03 07:38:47.879'),
('d3067f6c98ea40e8b62054267', '24b17aa57dee4cbc91aa6f7f4', '2026-03-03 07:38:47.886'),
('d55d006f467f4b768ebe812e3', '732e0856c55145b9be82c9101', '2026-03-03 07:38:47.886');

-- --------------------------------------------------------

--
-- Table structure for table `project_schemas`
--

CREATE TABLE `project_schemas` (
  `id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `latest_dump_id` varchar(36) DEFAULT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `project_schemas`
--

INSERT INTO `project_schemas` (`id`, `project_id`, `name`, `latest_dump_id`, `createdAt`, `updatedAt`) VALUES
('0a7ab08e110c4462b033fdcc2', '613093a360754771bff9110a2', 'main', '1ea1c631264843bba0e834c0f', '2026-03-03 07:38:47.851', '2026-03-03 07:38:47.867'),
('0f24c7bac10746079f2723b58', '7cc5e9ef4bc741d19c7231007', 'main', '68232d9ed86848c68f9c1409d', '2026-03-05 12:46:14.578', '2026-03-05 12:46:31.180'),
('2735e70e3ff746169ced3334a', 'd55d006f467f4b768ebe812e3', 'main', '4c16b75037cf42fdb96fa3f97', '2026-03-03 07:38:47.855', '2026-03-03 07:38:47.872'),
('3656f0f18fb04782bc865b12e', '0d3a848b6eba4868afdfbbed4', 'main', '5d54a4b62bd2437695410d178', '2026-03-03 07:38:47.853', '2026-03-03 07:38:47.869'),
('3b6594f25c57405abab35ad37', '0affd53d4e2845e5a2cd1c135', 'main', '5a1ff49364f044628045bbf24', '2026-03-05 12:46:14.564', '2026-03-05 12:46:31.173'),
('3e84691c2dcc4324aaa5e6265', '4cec4a3558974153b311c62eb', 'main', 'e61af7fd7ed24804867d8903b', '2026-03-03 07:38:47.847', '2026-03-03 07:38:47.862'),
('44734ae1b487479995dd25d7c', '04c1b2d9cc174a19b8a885b6f', 'main', 'cab2d954c401440dbe134acb4', '2026-03-05 12:46:14.573', '2026-03-05 12:46:31.178'),
('46c7bc58546a440e81c4b6afc', '32f4cc290f5c427e87a0429ab', 'main', '256a3c2798974435afa2c86e5', '2026-03-03 07:38:47.845', '2026-03-03 07:38:47.858'),
('490c79184b3342928b9b26ddb', 'a1952da3e5054e68b0ce66163', 'main', 'f1d584b4f7ec41c7926882c30', '2026-03-03 07:38:47.856', '2026-03-03 07:38:47.876'),
('58f01453f93b474b8c5ae52ff', 'bce98f55d6134c209ddab0760', 'main', '2b84011f642d42f98e25f86d8', '2026-03-05 12:46:14.560', '2026-03-05 12:46:31.169'),
('6f8d11ca44da4795b3041af7a', 'd290f94f1f584ddd903e19248', 'main', '7412351ef96a4fdf8fbc91efa', '2026-03-03 07:38:47.850', '2026-03-03 07:38:47.865'),
('8ca2d3b723144d549a5944bd2', '0b3ffac8192140f0a56ed07f7', 'main', '2d49e86ac15e4297944f8d768', '2026-03-05 12:46:14.557', '2026-03-05 12:46:31.166'),
('90fc516eb9a34c8c907f4b926', 'd3067f6c98ea40e8b62054267', 'main', '7f9c488b98394950a89fb887e', '2026-03-03 07:38:47.854', '2026-03-03 07:38:47.870'),
('9d834464e3054b3b932439875', '7de1171a92184d47bb22e3167', 'main', '4d77e4251d674f83865ad2601', '2026-03-05 12:46:14.571', '2026-03-05 12:46:31.175'),
('c9a108e46c7b4658bbb99278f', '080ad90c377a4aca80fb7cf2f', 'main', '8a6c4c59764a40aa9a58b8ea2', '2026-03-05 12:46:14.551', '2026-03-05 12:46:31.163'),
('cb640a5aa455462da56a49998', '505f2dfc54634b2581bb2c4b1', 'main', 'aaf1299a9bce4682ba058405c', '2026-03-05 12:46:14.584', '2026-03-05 12:46:31.181');

-- --------------------------------------------------------

--
-- Table structure for table `repository`
--

CREATE TABLE `repository` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `url` varchar(512) NOT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `repository`
--

INSERT INTO `repository` (`id`, `guildConfigId`, `name`, `url`, `createdAt`, `updatedAt`) VALUES
('24b17aa57dee4cbc91aa6f7f4', '471aee71717945e493b253de7', 'Badar_HMS_Node', 'https://github.com/GranjurTech/Badar_HMS_Node', '2026-03-03 07:38:47.822', '2026-03-03 07:39:58.469'),
('3cea873f06f04c4b9a4956fd8', '27f45a18a74d4bfc96d784adf', 'CSAAS_Backend', 'https://github.com/Aashir-Adnan/CSAAS_Backend', '2026-03-05 12:46:14.491', '2026-03-05 12:46:14.491'),
('4dcb669636b647b495da936e2', '27f45a18a74d4bfc96d784adf', 'Framework_React', 'https://github.com/UBS-Dev-Org/Framework_React', '2026-03-05 12:46:14.485', '2026-03-05 12:46:14.485'),
('4ec1cd0101954a9c8da4c7c07', '471aee71717945e493b253de7', 'FrameworkScript', 'https://github.com/UBS-Dev-Org/FrameworkScript', '2026-03-03 07:38:47.820', '2026-03-03 07:39:58.469'),
('60a945fdce4f449f826b71578', '471aee71717945e493b253de7', 'Ilmversity_aicredits_node_v2', 'https://github.com/ilmversity/Ilmversity_aicredits_node_v2', '2026-03-03 07:38:47.825', '2026-03-03 07:39:58.469'),
('732e0856c55145b9be82c9101', '471aee71717945e493b253de7', 'CSAAS_Backend', 'https://github.com/Aashir-Adnan/CSAAS_Backend', '2026-03-03 07:38:47.827', '2026-03-03 07:39:58.469'),
('a1854e527abd4e80be709fe31', '471aee71717945e493b253de7', 'Framework_React', 'https://github.com/UBS-Dev-Org/Framework_React', '2026-03-03 07:38:47.824', '2026-03-03 07:39:58.469'),
('a7a25b0f3835480bbca95cdd7', '27f45a18a74d4bfc96d784adf', 'UBS-Doc', 'https://github.com/Aashir-Adnan/UBS-Doc', '2026-03-05 12:46:14.494', '2026-03-05 12:46:14.494'),
('b4cddd56f35e432884f5eedf1', '27f45a18a74d4bfc96d784adf', 'Edarete_Node', 'https://github.com/ITULahore/Edarete_Node', '2026-03-05 12:46:14.471', '2026-03-05 12:46:14.471'),
('cb1ffd9c40b24cd0b08c20566', '471aee71717945e493b253de7', 'Edarete_React', 'https://github.com/ITULahore/Edarete_React', '2026-03-03 07:38:47.818', '2026-03-03 07:39:58.469'),
('cbf25c6ceb8640fc8ecd16ff4', '27f45a18a74d4bfc96d784adf', 'Badar_HMS_Node', 'https://github.com/GranjurTech/Badar_HMS_Node', '2026-03-05 12:46:14.482', '2026-03-05 12:46:14.482'),
('d1af282f83cc4d3dada930636', '471aee71717945e493b253de7', 'Edarete_Node', 'https://github.com/ITULahore/Edarete_Node', '2026-03-03 07:38:47.815', '2026-03-03 07:39:58.469'),
('d90f409fbf594a488d3440ee2', '471aee71717945e493b253de7', 'UBS-Doc', 'https://github.com/Aashir-Adnan/UBS-Doc', '2026-03-03 07:38:47.828', '2026-03-03 07:39:58.469'),
('decef2b5f1d046b4940ab5b19', '471aee71717945e493b253de7', 'ScholarSpace-UBS-Framework', 'https://github.com/Aashir-Adnan/ScholarSpace-UBS-Framework', '2026-03-03 07:38:47.829', '2026-03-03 07:39:58.469'),
('e26eab13cf7e40a4a4ca428e0', '27f45a18a74d4bfc96d784adf', 'Edarete_React', 'https://github.com/ITULahore/Edarete_React', '2026-03-05 12:46:14.473', '2026-03-05 12:46:14.473'),
('ec5c88ee60d34cdbb528e246b', '27f45a18a74d4bfc96d784adf', 'Ilmversity_aicredits_node_v2', 'https://github.com/ilmversity/Ilmversity_aicredits_node_v2', '2026-03-05 12:46:14.488', '2026-03-05 12:46:14.488'),
('f246f4425414496a9e8ddd3ad', '471aee71717945e493b253de7', 'Framework_Node', 'https://github.com/UBS-Dev-Org/Framework_Node', '2026-03-03 07:38:47.812', '2026-03-03 07:39:58.469'),
('f276caf1689e43c6a84392150', '27f45a18a74d4bfc96d784adf', 'FrameworkScript', 'https://github.com/UBS-Dev-Org/FrameworkScript', '2026-03-05 12:46:14.476', '2026-03-05 12:46:14.476'),
('f6e1e02e59484543937f690ea', '27f45a18a74d4bfc96d784adf', 'ScholarSpace-UBS-Framework', 'https://github.com/Aashir-Adnan/ScholarSpace-UBS-Framework', '2026-03-05 12:46:14.496', '2026-03-05 12:46:14.496'),
('f9902bcaaac9418491ebe2e85', '27f45a18a74d4bfc96d784adf', 'Framework_Node', 'https://github.com/UBS-Dev-Org/Framework_Node', '2026-03-05 12:46:14.458', '2026-03-05 12:46:14.458');

-- --------------------------------------------------------

--
-- Table structure for table `scheduledmeeting`
--

CREATE TABLE `scheduledmeeting` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `topic` text NOT NULL,
  `scheduledAt` datetime(3) NOT NULL,
  `memberIds` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`memberIds`)),
  `createdBy` varchar(64) NOT NULL,
  `reminderSentAt` datetime(3) DEFAULT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `schema_migrations`
--

CREATE TABLE `schema_migrations` (
  `name` varchar(255) NOT NULL,
  `run_at` datetime(3) DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `schema_migrations`
--

INSERT INTO `schema_migrations` (`name`, `run_at`) VALUES
('001_feature_multi_repos_scopes_modules.sql', '2026-03-03 08:46:06.801'),
('002_pending_invite.sql', '2026-03-03 08:46:06.841'),
('003_assignable_roles.sql', '2026-03-03 09:19:03.379'),
('004_unified_task_bugs_features.sql', '2026-03-03 10:26:24.782'),
('005_guild_clocked_in_role.sql', '2026-03-03 12:38:13.180');

-- --------------------------------------------------------

--
-- Table structure for table `task`
--

CREATE TABLE `task` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `type` varchar(32) NOT NULL,
  `modules` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`modules`)),
  `handlerId` varchar(64) DEFAULT NULL,
  `scope` text DEFAULT NULL,
  `implementationStatus` varchar(32) DEFAULT NULL,
  `passedApiTests` tinyint(1) DEFAULT NULL,
  `passedQaTests` tinyint(1) DEFAULT NULL,
  `passedAcceptanceCriteria` tinyint(1) DEFAULT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3),
  `is_bug` tinyint(1) NOT NULL DEFAULT 0,
  `is_feature` tinyint(1) NOT NULL DEFAULT 0,
  `title` text DEFAULT NULL,
  `description` text DEFAULT NULL,
  `status` varchar(32) DEFAULT 'open',
  `createdBy` varchar(64) DEFAULT NULL,
  `assigneeIds` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`assigneeIds`)),
  `taggedMemberIds` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT '[]' CHECK (json_valid(`taggedMemberIds`)),
  `repositoryId` varchar(36) DEFAULT NULL,
  `projectId` varchar(255) DEFAULT NULL,
  `projectName` varchar(255) DEFAULT NULL,
  `discordChannelId` varchar(64) DEFAULT NULL,
  `discordThreadId` varchar(64) DEFAULT NULL,
  `externalIssueUrl` varchar(512) DEFAULT NULL,
  `externalIssueNumber` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `task`
--

INSERT INTO `task` (`id`, `guildConfigId`, `type`, `modules`, `handlerId`, `scope`, `implementationStatus`, `passedApiTests`, `passedQaTests`, `passedAcceptanceCriteria`, `createdAt`, `updatedAt`, `is_bug`, `is_feature`, `title`, `description`, `status`, `createdBy`, `assigneeIds`, `taggedMemberIds`, `repositoryId`, `projectId`, `projectName`, `discordChannelId`, `discordThreadId`, `externalIssueUrl`, `externalIssueNumber`) VALUES
('0f13a1a708d945cea1e516431', '471aee71717945e493b253de7', 'feature', '[\"Project Creation\"]', NULL, 'Backend', 'done', NULL, NULL, NULL, '2026-03-03 10:30:58.799', '2026-03-03 10:54:26.957', 0, 1, 'Add Check File', 'Generation script should write a check file in the root directory to signal pipeline start', 'closed', '545956110272692234', '[\"1476450967548596385\"]', '[]', '732e0856c55145b9be82c9101', NULL, NULL, '1478263390442098849', NULL, NULL, NULL),
('70aa15b8d28a4853a73c6a421', '471aee71717945e493b253de7', 'feature', '[\"Project Generation\"]', NULL, 'Backend', 'not_started', NULL, NULL, NULL, '2026-03-03 11:40:22.750', '2026-03-03 11:40:23.851', 0, 1, 'Add Check File', 'Generation script should write a check file in the root directory to signal pipeline start', 'open', '545956110272692234', '[\"1476450967548596385\"]', '[]', '732e0856c55145b9be82c9101', NULL, NULL, '1478280857566314548', NULL, NULL, NULL);

-- --------------------------------------------------------

--
-- Table structure for table `ticketdoc`
--

CREATE TABLE `ticketdoc` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `ticketType` varchar(32) NOT NULL,
  `title` varchar(512) NOT NULL,
  `content` text DEFAULT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3),
  `updatedAt` datetime(3) DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3),
  `taskId` varchar(36) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `ticketdoc`
--

INSERT INTO `ticketdoc` (`id`, `guildConfigId`, `ticketType`, `title`, `content`, `createdAt`, `updatedAt`, `taskId`) VALUES
('10dad3333c284fd9a1398d528', '471aee71717945e493b253de7', 'feature', 'Add Check File', NULL, '2026-03-03 11:40:22.766', '2026-03-03 11:40:22.766', '70aa15b8d28a4853a73c6a421'),
('116fd55d583c4244bde01ed3d', '471aee71717945e493b253de7', 'feature', 'Add Check File', 'Test', '2026-03-03 10:30:58.813', '2026-03-03 10:54:26.954', '0f13a1a708d945cea1e516431');

-- --------------------------------------------------------

--
-- Table structure for table `verificationotp`
--

CREATE TABLE `verificationotp` (
  `id` varchar(36) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `discordId` varchar(64) NOT NULL,
  `email` varchar(255) NOT NULL,
  `code` varchar(8) NOT NULL,
  `expiresAt` datetime(3) NOT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `verificationtoken`
--

CREATE TABLE `verificationtoken` (
  `id` varchar(36) NOT NULL,
  `token` varchar(255) NOT NULL,
  `guildConfigId` varchar(36) NOT NULL,
  `discordId` varchar(64) NOT NULL,
  `email` varchar(255) NOT NULL,
  `expiresAt` datetime(3) NOT NULL,
  `createdAt` datetime(3) DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `bugticketcomment`
--
ALTER TABLE `bugticketcomment`
  ADD PRIMARY KEY (`id`),
  ADD KEY `taskId` (`taskId`);

--
-- Indexes for table `clockentry`
--
ALTER TABLE `clockentry`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guildConfigId` (`guildConfigId`,`discordId`),
  ADD KEY `clockInAt` (`clockInAt`);

--
-- Indexes for table `dump_versions`
--
ALTER TABLE `dump_versions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `project_schema_id` (`project_schema_id`);

--
-- Indexes for table `email_log`
--
ALTER TABLE `email_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `recipient_email` (`recipient_email`),
  ADD KEY `guildConfigId` (`guildConfigId`);

--
-- Indexes for table `faq`
--
ALTER TABLE `faq`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guildConfigId` (`guildConfigId`),
  ADD KEY `repositoryId` (`repositoryId`),
  ADD KEY `status` (`status`);

--
-- Indexes for table `feature_project_schemas`
--
ALTER TABLE `feature_project_schemas`
  ADD PRIMARY KEY (`task_id`,`project_schema_id`),
  ADD KEY `project_schema_id` (`project_schema_id`);

--
-- Indexes for table `feature_repositories`
--
ALTER TABLE `feature_repositories`
  ADD PRIMARY KEY (`task_id`,`repository_id`),
  ADD KEY `repository_id` (`repository_id`);

--
-- Indexes for table `guildconfig`
--
ALTER TABLE `guildconfig`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guildId` (`guildId`);

--
-- Indexes for table `guildmember`
--
ALTER TABLE `guildmember`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guildConfigId` (`guildConfigId`,`discordId`),
  ADD KEY `guildConfigId_2` (`guildConfigId`),
  ADD KEY `email` (`email`);

--
-- Indexes for table `guild_assignable_roles`
--
ALTER TABLE `guild_assignable_roles`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guildConfigId` (`guildConfigId`,`name`),
  ADD KEY `guildConfigId_2` (`guildConfigId`);

--
-- Indexes for table `guild_modules`
--
ALTER TABLE `guild_modules`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guildConfigId` (`guildConfigId`,`name`),
  ADD KEY `guildConfigId_2` (`guildConfigId`);

--
-- Indexes for table `guild_scopes`
--
ALTER TABLE `guild_scopes`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guildConfigId` (`guildConfigId`,`name`),
  ADD KEY `guildConfigId_2` (`guildConfigId`);

--
-- Indexes for table `meeting`
--
ALTER TABLE `meeting`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guildConfigId` (`guildConfigId`);

--
-- Indexes for table `meetingchannel`
--
ALTER TABLE `meetingchannel`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `meetingId` (`meetingId`),
  ADD KEY `guildConfigId` (`guildConfigId`);

--
-- Indexes for table `pendinginvite`
--
ALTER TABLE `pendinginvite`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guildConfigId` (`guildConfigId`),
  ADD KEY `guildConfigId_2` (`guildConfigId`,`inviteCode`);

--
-- Indexes for table `project`
--
ALTER TABLE `project`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guildConfigId` (`guildConfigId`,`name`),
  ADD KEY `guildConfigId_2` (`guildConfigId`);

--
-- Indexes for table `projectschema`
--
ALTER TABLE `projectschema`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guildConfigId` (`guildConfigId`,`projectId`),
  ADD KEY `guildConfigId_2` (`guildConfigId`);

--
-- Indexes for table `project_repos`
--
ALTER TABLE `project_repos`
  ADD PRIMARY KEY (`project_id`,`repository_id`),
  ADD KEY `repository_id` (`repository_id`);

--
-- Indexes for table `project_schemas`
--
ALTER TABLE `project_schemas`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `project_id` (`project_id`,`name`),
  ADD KEY `project_id_2` (`project_id`);

--
-- Indexes for table `repository`
--
ALTER TABLE `repository`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `guildConfigId` (`guildConfigId`,`url`),
  ADD KEY `guildConfigId_2` (`guildConfigId`);

--
-- Indexes for table `scheduledmeeting`
--
ALTER TABLE `scheduledmeeting`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guildConfigId` (`guildConfigId`),
  ADD KEY `createdBy` (`createdBy`),
  ADD KEY `scheduledAt` (`scheduledAt`);

--
-- Indexes for table `schema_migrations`
--
ALTER TABLE `schema_migrations`
  ADD PRIMARY KEY (`name`);

--
-- Indexes for table `task`
--
ALTER TABLE `task`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guildConfigId` (`guildConfigId`),
  ADD KEY `type` (`type`);

--
-- Indexes for table `ticketdoc`
--
ALTER TABLE `ticketdoc`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guildConfigId` (`guildConfigId`),
  ADD KEY `taskId` (`taskId`);

--
-- Indexes for table `verificationotp`
--
ALTER TABLE `verificationotp`
  ADD PRIMARY KEY (`id`),
  ADD KEY `guildConfigId` (`guildConfigId`,`discordId`),
  ADD KEY `email` (`email`,`code`);

--
-- Indexes for table `verificationtoken`
--
ALTER TABLE `verificationtoken`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `token` (`token`),
  ADD KEY `token_2` (`token`),
  ADD KEY `guildConfigId` (`guildConfigId`,`discordId`);

--
-- Constraints for dumped tables
--

--
-- Constraints for table `bugticketcomment`
--
ALTER TABLE `bugticketcomment`
  ADD CONSTRAINT `BugTicketComment_taskId_fk` FOREIGN KEY (`taskId`) REFERENCES `task` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `clockentry`
--
ALTER TABLE `clockentry`
  ADD CONSTRAINT `clockentry_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `dump_versions`
--
ALTER TABLE `dump_versions`
  ADD CONSTRAINT `dump_versions_ibfk_1` FOREIGN KEY (`project_schema_id`) REFERENCES `project_schemas` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `email_log`
--
ALTER TABLE `email_log`
  ADD CONSTRAINT `email_log_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE SET NULL;

--
-- Constraints for table `faq`
--
ALTER TABLE `faq`
  ADD CONSTRAINT `faq_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `faq_ibfk_2` FOREIGN KEY (`repositoryId`) REFERENCES `repository` (`id`);

--
-- Constraints for table `feature_project_schemas`
--
ALTER TABLE `feature_project_schemas`
  ADD CONSTRAINT `feature_project_schemas_ibfk_2` FOREIGN KEY (`project_schema_id`) REFERENCES `projectschema` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `feature_project_schemas_task_fk` FOREIGN KEY (`task_id`) REFERENCES `task` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `feature_repositories`
--
ALTER TABLE `feature_repositories`
  ADD CONSTRAINT `feature_repositories_ibfk_2` FOREIGN KEY (`repository_id`) REFERENCES `repository` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `feature_repositories_task_fk` FOREIGN KEY (`task_id`) REFERENCES `task` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `guildmember`
--
ALTER TABLE `guildmember`
  ADD CONSTRAINT `guildmember_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `guild_assignable_roles`
--
ALTER TABLE `guild_assignable_roles`
  ADD CONSTRAINT `guild_assignable_roles_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `guild_modules`
--
ALTER TABLE `guild_modules`
  ADD CONSTRAINT `guild_modules_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `guild_scopes`
--
ALTER TABLE `guild_scopes`
  ADD CONSTRAINT `guild_scopes_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `meeting`
--
ALTER TABLE `meeting`
  ADD CONSTRAINT `meeting_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `meetingchannel`
--
ALTER TABLE `meetingchannel`
  ADD CONSTRAINT `meetingchannel_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `meetingchannel_ibfk_2` FOREIGN KEY (`meetingId`) REFERENCES `meeting` (`id`);

--
-- Constraints for table `pendinginvite`
--
ALTER TABLE `pendinginvite`
  ADD CONSTRAINT `pendinginvite_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `project`
--
ALTER TABLE `project`
  ADD CONSTRAINT `project_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `projectschema`
--
ALTER TABLE `projectschema`
  ADD CONSTRAINT `projectschema_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `project_repos`
--
ALTER TABLE `project_repos`
  ADD CONSTRAINT `project_repos_ibfk_1` FOREIGN KEY (`project_id`) REFERENCES `project` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `project_repos_ibfk_2` FOREIGN KEY (`repository_id`) REFERENCES `repository` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `project_schemas`
--
ALTER TABLE `project_schemas`
  ADD CONSTRAINT `project_schemas_ibfk_1` FOREIGN KEY (`project_id`) REFERENCES `project` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `repository`
--
ALTER TABLE `repository`
  ADD CONSTRAINT `repository_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `scheduledmeeting`
--
ALTER TABLE `scheduledmeeting`
  ADD CONSTRAINT `scheduledmeeting_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `task`
--
ALTER TABLE `task`
  ADD CONSTRAINT `task_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `ticketdoc`
--
ALTER TABLE `ticketdoc`
  ADD CONSTRAINT `TicketDoc_taskId_fk` FOREIGN KEY (`taskId`) REFERENCES `task` (`id`) ON DELETE SET NULL,
  ADD CONSTRAINT `ticketdoc_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `verificationotp`
--
ALTER TABLE `verificationotp`
  ADD CONSTRAINT `verificationotp_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `verificationtoken`
--
ALTER TABLE `verificationtoken`
  ADD CONSTRAINT `verificationtoken_ibfk_1` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
