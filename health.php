<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

// Simple health check
$status = 'ok';
$message = 'Proxy is working';

echo json_encode(['status' => $status, 'message' => $message]);
?>
