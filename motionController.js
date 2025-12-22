/**
 * Motion Controller - Handles device tilt detection
 * Uses Device Orientation API to track phone tilt
 */

class MotionController {
    constructor() {
        this.isActive = false;
        this.currentTilt = 0; // Normalized tilt (0-1)
        this.rawBeta = 0; // Raw beta value from sensor
        this.minTilt = 0;
        this.maxTilt = 0;
        this.onTiltChange = null; // Callback function
    }

    /**
     * Request permission and start tracking motion
     */
    async requestPermission() {
        try {
            if (typeof DeviceOrientationEvent !== 'undefined' &&
                typeof DeviceOrientationEvent.requestPermission === 'function') {
                const permission = await DeviceOrientationEvent.requestPermission();
                if (permission !== 'granted') {
                    throw new Error('Permission denied');
                }
            }
            return true;
        } catch (error) {
            console.error('Motion permission error:', error);
            throw error;
        }
    }

    /**
     * Start tracking device orientation
     */
    start() {
        this.isActive = true;
        window.addEventListener('deviceorientation', this._handleOrientation.bind(this));
    }

    /**
     * Stop tracking device orientation
     */
    stop() {
        this.isActive = false;
        window.removeEventListener('deviceorientation', this._handleOrientation.bind(this));
    }

    /**
     * Set calibration values
     */
    setCalibration(minTilt, maxTilt) {
        this.minTilt = minTilt;
        this.maxTilt = maxTilt;
    }

    /**
     * Handle orientation event
     */
    _handleOrientation(event) {
        if (!this.isActive) return;

        // When phone is lying screen-up, we use beta (front-to-back tilt)
        // beta: -180 to 180 degrees
        // When phone is flat: beta ≈ 0
        // Tilted towards user (top up): beta < 0
        // Tilted away from user (top down): beta > 0
        const beta = event.beta;

        if (beta === null) return;

        // Store raw beta
        this.rawBeta = beta;

        // Map the current beta to normalized value between min and max calibration
        if (this.minTilt !== 0 || this.maxTilt !== 0) {
            // Calibrated mode
            const range = this.maxTilt - this.minTilt;
            const normalized = (beta - this.minTilt) / range;
            this.currentTilt = Math.max(0, Math.min(1, normalized)); // Clamp to 0-1
        } else {
            // Uncalibrated mode - just pass through raw beta
            this.currentTilt = beta;
        }

        // Call callback if set
        if (this.onTiltChange) {
            this.onTiltChange(this.currentTilt, beta);
        }
    }

    /**
     * Get current raw tilt value (raw beta from sensor)
     */
    getRawTilt() {
        return this.rawBeta;
    }

    /**
     * Get current normalized tilt (0-1)
     */
    getNormalizedTilt() {
        return this.currentTilt;
    }

    /**
     * Get calibration data
     */
    getCalibrationData() {
        return {
            min: this.minTilt,
            max: this.maxTilt
        };
    }
}
