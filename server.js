const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = 3000;

// Candidate state
let candidateState = {
    events: [],             // List of flagged events with timestamps and contributions
    riskScore: 0,          // Current risk score
    lockStatus: false,      // Whether the test is locked
    highRiskEntries: [],   // Times when risk score exceeds 60
    temporaryLockEnd: null, // End time for temporary lock
    calibrationData: {      // Baseline data from calibration phase
        mouseMean: 0,
        mouseStd: 0,
        keyMean: 0,
        keyStd: 0
    },
    assessmentState: {
        currentQuestion: 0,
        answers: [],
        startTime: null,
        endTime: null
    },
    blockedActivities: {    // Activities that are blocked
        tabSwitch: true,
        copyPaste: true,
        rightClick: true,
        shortcuts: true
    }
};

const LAMBDA = Math.log(2) / 300; // Decay constant (half-life: 5 minutes = 300 seconds)

// Calculate risk score with exponential decay
function calculateRiskScore() {
    const now = Date.now() / 1000;

    // Calculate decayed risk score for each event
    let score = candidateState.events.reduce((total, event) => {
        const age = now - event.timestamp;
        const contribution = event.A * Math.exp(-LAMBDA * age);
        return total + contribution;
    }, 0);

    // Limit score to 100 maximum
    candidateState.riskScore = Math.min(score, 100);

    // Clean up old events that no longer contribute significantly
    candidateState.events = candidateState.events.filter(event => {
        const age = now - event.timestamp;
        return age < 1800 || event.A * Math.exp(-LAMBDA * age) > 0.5;
    });

    return candidateState.riskScore;
}

// Get event severity based on type and context
function getEventSeverity(eventType, context = {}) {
    const severities = {
        'tab_switch': 20,
        'inactivity': 10,
        'unusual_mouse': 15,
        'unusual_keystroke': 15,
        'fullscreen_exit': 25,
        'copy_paste': 20,
        'right_click': 15,
        'keyboard_shortcut': 15
    };

    let severity = severities[eventType] || 5;

    // Adjust severity based on context
    if (context.blocked) {
        severity *= 2; // Double severity for blocked activities
    }
    if (context.repeated) {
        severity *= 1.5; // Increase severity for repeated violations
    }
    if (context.duration) {
        severity *= (1 + Math.min(context.duration / 60, 1)); // Increase severity based on duration
    }

    return Math.min(severity, 100); // Cap severity at 100
}

// Handle socket connections
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Join specific room
    socket.on('join', (room) => {
        socket.join(room);
        console.log(`Client ${socket.id} joined room: ${room}`);

        // Send current state to admin when they connect
        if (room === 'admin') {
            socket.emit('update', {
                riskScore: candidateState.riskScore,
                events: candidateState.events,
                lockStatus: candidateState.lockStatus,
                highRiskCount: candidateState.highRiskEntries.length,
                blockedActivities: candidateState.blockedActivities,
                assessmentState: candidateState.assessmentState
            });
        }
        // Send blocked activities to candidate when they connect
        if (room === 'candidate') {
            socket.emit('blocked_activities_update', candidateState.blockedActivities);
        }
    });

    // Handle blocked activities updates from admin
    socket.on('update_blocked_activities', (activities) => {
        console.log('Updating blocked activities:', activities);
        // Validate the activities object
        const validActivities = ['tabSwitch', 'copyPaste', 'rightClick', 'shortcuts'];
        candidateState.blockedActivities = {
            tabSwitch: !!activities.tabSwitch,
            copyPaste: !!activities.copyPaste,
            rightClick: !!activities.rightClick,
            shortcuts: !!activities.shortcuts
        };

        // Notify all candidates about the update
        io.to('candidate').emit('blocked_activities_update', candidateState.blockedActivities);

        // Notify all admins about the update
        io.to('admin').emit('update', {
            riskScore: candidateState.riskScore,
            events: candidateState.events,
            lockStatus: candidateState.lockStatus,
            highRiskCount: candidateState.highRiskEntries.length,
            blockedActivities: candidateState.blockedActivities,
            assessmentState: candidateState.assessmentState
        });

        console.log('Updated blocked activities:', candidateState.blockedActivities);
    });

    // Receive calibration data
    socket.on('calibration_data', (data) => {
        console.log('Received calibration data:', data);
        candidateState.calibrationData = {
            mouseMean: data.mouseMean || 0,
            mouseStd: data.mouseStd || 0,
            keyMean: data.keyMean || 0,
            keyStd: data.keyStd || 0
        };
    });

    // Handle assessment state updates
    socket.on('assessment_update', (update) => {
        candidateState.assessmentState = {
            ...candidateState.assessmentState,
            ...update
        };
        io.to('admin').emit('assessment_state_update', candidateState.assessmentState);
    });

    // Receive flagged events
    socket.on('event', (event) => {
        const now = Date.now() / 1000;

        // Check if this is a blocked activity
        const isBlocked = candidateState.blockedActivities[event.type];

        // Check for repeated violations
        const recentViolations = candidateState.events
            .filter(e => e.type === event.type && now - e.timestamp < 300)
            .length;

        const context = {
            repeated: recentViolations > 0,
            duration: event.duration,
            blocked: isBlocked
        };

        // Get severity - blocked activities have higher severity
        const A = getEventSeverity(event.type, context);

        // Log the event
        candidateState.events.push({
            timestamp: now,
            type: event.type,
            A: A,
            blocked: isBlocked,
            details: event.value ? `Value: ${event.value}` : ''
        });

        // If the activity was blocked, send a warning to the candidate
        if (isBlocked) {
            socket.emit('activity_blocked', {
                type: event.type,
                message: `This action (${event.type}) is not allowed during the test.`
            });
        }

        // Immediately recalculate risk score
        calculateRiskScore();

        // Check if this pushes into high-risk territory
        if (candidateState.riskScore > 60) {
            const lastHighRisk = candidateState.highRiskEntries.length > 0 ?
                candidateState.highRiskEntries[candidateState.highRiskEntries.length - 1] : 0;

            if (now - lastHighRisk > 60) {
                candidateState.highRiskEntries.push(now);
                handleHighRiskAction();
            }
        }

        // Update all admins with new event
        io.to('admin').emit('update', {
            riskScore: candidateState.riskScore,
            events: candidateState.events,
            lockStatus: candidateState.lockStatus,
            highRiskCount: candidateState.highRiskEntries.length,
            blockedActivities: candidateState.blockedActivities,
            assessmentState: candidateState.assessmentState
        });
    });

    // Handle admin overrides
    socket.on('override', (action) => {
        console.log('Admin override:', action);
        if (action === 'unlock') {
            candidateState.lockStatus = false;
            candidateState.temporaryLockEnd = null;
            io.to('candidate').emit('unlock');
            console.log('Test unlocked by admin');
        } else if (action === 'disqualify') {
            candidateState.lockStatus = true;
            io.to('candidate').emit('disqualify');
            console.log('Candidate disqualified by admin');
        }

        // Update admin UI after override
        io.to('admin').emit('update', {
            riskScore: candidateState.riskScore,
            events: candidateState.events,
            lockStatus: candidateState.lockStatus,
            highRiskCount: candidateState.highRiskEntries.length,
            blockedActivities: candidateState.blockedActivities,
            assessmentState: candidateState.assessmentState
        });
    });

    socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// Handle high risk actions based on count of high risk entries
function handleHighRiskAction() {
    const now = Date.now() / 1000;

    // Filter high-risk entries within the last 10 minutes
    candidateState.highRiskEntries = candidateState.highRiskEntries.filter(
        entry => now - entry < 600
    );

    const highRiskCount = candidateState.highRiskEntries.length;
    let action = null;

    if (highRiskCount === 1) {
        action = 'strict_warning';
        console.log('Issuing strict warning');
    } else if (highRiskCount === 2) {
        action = 'temporary_lock';
        candidateState.lockStatus = true;
        candidateState.temporaryLockEnd = now + 60; // Lock for 60 seconds
        console.log('Initiating temporary lock');
    } else if (highRiskCount >= 3) {
        action = 'test_lock';
        candidateState.lockStatus = true;
        console.log('Initiating test lock');
    }

    if (action) {
        io.to('candidate').emit('action', action);
    }
}

// Periodic risk score calculation and actions
setInterval(() => {
    const now = Date.now() / 1000;
    calculateRiskScore();

    // Check if temporary lock should be released
    if (candidateState.temporaryLockEnd && now > candidateState.temporaryLockEnd) {
        candidateState.lockStatus = false;
        candidateState.temporaryLockEnd = null;
        io.to('candidate').emit('unlock');
        console.log('Temporary lock automatically expired');
    }

    // Take action based on current risk score
    let action = null;
    if (candidateState.riskScore > 30 && candidateState.riskScore <= 60) {
        action = 'subtle_nudge';
    }

    if (action) {
        io.to('candidate').emit('action', action);
    }

    // Update admin portal
    io.to('admin').emit('update', {
        riskScore: candidateState.riskScore,
        events: candidateState.events,
        lockStatus: candidateState.lockStatus,
        highRiskCount: candidateState.highRiskEntries.length,
        blockedActivities: candidateState.blockedActivities,
        assessmentState: candidateState.assessmentState
    });
}, 2000); // Update every 2 seconds

// Serve static files
app.use(express.static('public'));

// Serve portals
app.get('/', (req, res) => res.sendFile(__dirname + '/candidate.html'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));