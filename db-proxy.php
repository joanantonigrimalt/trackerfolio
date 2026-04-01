<?php
// MySQL Proxy API - PHP version for cPanel
// Save as: /home/joantoni/public_html/db-proxy/index.php

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-DB-Token');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Configuration
$MYSQL_HOST = getenv('MYSQL_HOST') ?: 'localhost';
$MYSQL_USER = getenv('MYSQL_USER') ?: 'joanT';
$MYSQL_PASSWORD = getenv('MYSQL_PASSWORD') ?: '@@JTONY22@@';
$MYSQL_DATABASE = getenv('MYSQL_DATABASE') ?: 'joantoni';
$DB_PROXY_TOKEN = getenv('DB_PROXY_TOKEN') ?: 'change-me';

// Route parsing
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$path = trim(str_replace('/db-proxy', '', $path), '/');

// Health check
if ($path === 'health' || $path === '') {
    try {
        $conn = new mysqli($MYSQL_HOST, $MYSQL_USER, $MYSQL_PASSWORD, $MYSQL_DATABASE);
        if ($conn->connect_error) {
            throw new Exception($conn->connect_error);
        }
        $conn->close();
        echo json_encode(['status' => 'ok', 'message' => 'Database connected']);
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['status' => 'error', 'message' => $e->getMessage()]);
    }
    exit;
}

// Query endpoint (SELECT only)
if ($path === 'query') {
    $input = json_decode(file_get_contents('php://input'), true);
    $sql = $input['sql'] ?? '';
    $params = $input['params'] ?? [];

    if (!$sql || !preg_match('/^\s*SELECT\s/i', $sql)) {
        http_response_code(400);
        echo json_encode(['error' => 'Only SELECT queries allowed']);
        exit;
    }

    try {
        $conn = new mysqli($MYSQL_HOST, $MYSQL_USER, $MYSQL_PASSWORD, $MYSQL_DATABASE);
        $stmt = $conn->prepare($sql);
        if ($params) {
            $types = str_repeat('s', count($params));
            $stmt->bind_param($types, ...$params);
        }
        $stmt->execute();
        $result = $stmt->get_result();
        $data = $result->fetch_all(MYSQLI_ASSOC);

        echo json_encode(['data' => $data, 'count' => count($data)]);
        $conn->close();
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

// Exec endpoint (requires token)
if ($path === 'exec') {
    $token = $_SERVER['HTTP_X_DB_TOKEN'] ?? '';
    if ($token !== $DB_PROXY_TOKEN) {
        http_response_code(401);
        echo json_encode(['error' => 'Unauthorized']);
        exit;
    }

    $input = json_decode(file_get_contents('php://input'), true);
    $sql = $input['sql'] ?? '';
    $params = $input['params'] ?? [];

    if (!$sql) {
        http_response_code(400);
        echo json_encode(['error' => 'SQL required']);
        exit;
    }

    try {
        $conn = new mysqli($MYSQL_HOST, $MYSQL_USER, $MYSQL_PASSWORD, $MYSQL_DATABASE);
        $stmt = $conn->prepare($sql);
        if ($params) {
            $types = str_repeat('s', count($params));
            $stmt->bind_param($types, ...$params);
        }
        $stmt->execute();

        echo json_encode([
            'affectedRows' => $conn->affected_rows,
            'insertId' => $conn->insert_id
        ]);
        $conn->close();
    } catch (Exception $e) {
        http_response_code(500);
        echo json_encode(['error' => $e->getMessage()]);
    }
    exit;
}

// Default: not found
http_response_code(404);
echo json_encode(['error' => 'Endpoint not found']);
?>
