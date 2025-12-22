/**
 * Game Logic - Pong game implementation
 */

class PongGame {
    constructor(canvasId, motionController) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.motionController = motionController;

        this.isRunning = false;
        this.playerScore = 0;
        this.aiScore = 0;

        // Game objects
        this.paddle = {
            width: 10,
            height: 100,
            x: 20,
            y: 0,
            speed: 8
        };

        this.aiPaddle = {
            width: 10,
            height: 100,
            x: 0,
            y: 0,
            speed: 2
        };

        this.ball = {
            x: 0,
            y: 0,
            radius: 8,
            speedX: 2,
            speedY: 2
        };

        this.resizeCanvas();
        this.initPositions();
    }

    /**
     * Resize canvas to fit screen
     */
    resizeCanvas() {
        this.canvas.width = Math.min(window.innerWidth, 600);
        this.canvas.height = Math.min(window.innerHeight, 800);

        // Update AI paddle X position
        this.aiPaddle.x = this.canvas.width - 30;
    }

    /**
     * Initialize game object positions
     */
    initPositions() {
        this.paddle.y = this.canvas.height / 2 - this.paddle.height / 2;
        this.aiPaddle.y = this.canvas.height / 2 - this.aiPaddle.height / 2;
        this.ball.x = this.canvas.width / 2;
        this.ball.y = this.canvas.height / 2;
    }

    /**
     * Start the game
     */
    start() {
        this.isRunning = true;
        this.gameLoop();
    }

    /**
     * Stop the game
     */
    stop() {
        this.isRunning = false;
    }

    /**
     * Main game loop
     */
    gameLoop() {
        if (!this.isRunning) return;

        this.update();
        this.draw();

        requestAnimationFrame(() => this.gameLoop());
    }

    /**
     * Update game state
     */
    update() {
        this.updatePaddle();
        this.updateAI();
        this.updateBall();
    }

    /**
     * Update player paddle based on motion controller
     */
    updatePaddle() {
        // Get normalized tilt (0 = bottom position, 1 = top position)
        const tilt = this.motionController.getNormalizedTilt();

        // Map tilt to paddle position
        // tilt 0 (bottom) -> paddle at bottom
        // tilt 1 (top) -> paddle at top
        const targetY = (1 - tilt) * (this.canvas.height - this.paddle.height);

        // Smooth movement
        this.paddle.y += (targetY - this.paddle.y) * 0.3;

        // Clamp position
        this.paddle.y = Math.max(0, Math.min(this.canvas.height - this.paddle.height, this.paddle.y));
    }

    /**
     * Update AI paddle
     */
    updateAI() {
        const paddleCenter = this.aiPaddle.y + this.aiPaddle.height / 2;
        const ballCenter = this.ball.y;

        if (paddleCenter < ballCenter - 35) {
            this.aiPaddle.y += this.aiPaddle.speed;
        } else if (paddleCenter > ballCenter + 35) {
            this.aiPaddle.y -= this.aiPaddle.speed;
        }

        // Clamp position
        this.aiPaddle.y = Math.max(0, Math.min(this.canvas.height - this.aiPaddle.height, this.aiPaddle.y));
    }

    /**
     * Update ball position and check collisions
     */
    updateBall() {
        this.ball.x += this.ball.speedX;
        this.ball.y += this.ball.speedY;

        // Top and bottom collision
        if (this.ball.y - this.ball.radius < 0 || this.ball.y + this.ball.radius > this.canvas.height) {
            this.ball.speedY = -this.ball.speedY;
        }

        // Player paddle collision
        if (this.ball.x - this.ball.radius < this.paddle.x + this.paddle.width &&
            this.ball.y > this.paddle.y &&
            this.ball.y < this.paddle.y + this.paddle.height) {
            this.ball.speedX = Math.abs(this.ball.speedX);

            // Add angle based on hit position
            const hitPos = (this.ball.y - this.paddle.y) / this.paddle.height;
            this.ball.speedY = (hitPos - 0.5) * 10;
        }

        // AI paddle collision
        if (this.ball.x + this.ball.radius > this.aiPaddle.x &&
            this.ball.y > this.aiPaddle.y &&
            this.ball.y < this.aiPaddle.y + this.aiPaddle.height) {
            this.ball.speedX = -Math.abs(this.ball.speedX);

            const hitPos = (this.ball.y - this.aiPaddle.y) / this.aiPaddle.height;
            this.ball.speedY = (hitPos - 0.5) * 10;
        }

        // Score points
        if (this.ball.x < 0) {
            this.aiScore++;
            this.resetBall();
        } else if (this.ball.x > this.canvas.width) {
            this.playerScore++;
            this.resetBall();
        }
    }

    /**
     * Reset ball to center
     */
    resetBall() {
        this.ball.x = this.canvas.width / 2;
        this.ball.y = this.canvas.height / 2;
        this.ball.speedX = -this.ball.speedX;
        this.ball.speedY = (Math.random() - 0.5) * 8;
    }

    /**
     * Draw game objects
     */
    draw() {
        // Clear screen
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // Center line
        this.ctx.strokeStyle = '#333';
        this.ctx.setLineDash([5, 15]);
        this.ctx.beginPath();
        this.ctx.moveTo(this.canvas.width / 2, 0);
        this.ctx.lineTo(this.canvas.width / 2, this.canvas.height);
        this.ctx.stroke();
        this.ctx.setLineDash([]);

        // Player paddle
        this.ctx.fillStyle = '#4CAF50';
        this.ctx.fillRect(this.paddle.x, this.paddle.y, this.paddle.width, this.paddle.height);

        // AI paddle
        this.ctx.fillStyle = '#F44336';
        this.ctx.fillRect(this.aiPaddle.x, this.aiPaddle.y, this.aiPaddle.width, this.aiPaddle.height);

        // Ball
        this.ctx.fillStyle = '#FFF';
        this.ctx.beginPath();
        this.ctx.arc(this.ball.x, this.ball.y, this.ball.radius, 0, Math.PI * 2);
        this.ctx.fill();
    }

    /**
     * Get current score
     */
    getScore() {
        return {
            player: this.playerScore,
            ai: this.aiScore
        };
    }
}
