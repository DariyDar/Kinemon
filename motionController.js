/**
 * Motion Controller - Handles device tilt detection
 * Uses Device Orientation API to track phone tilt
 */

class MotionController {
    constructor() {
        this.isActive = false;
        this.currentTilt = 0; // Normalized tilt (0-1)
        this.rawBeta = 0; // Raw beta value from sensor
        this.rawGamma = 0; // Raw gamma value from sensor
        this.minTilt = 0;
        this.maxTilt = 0;
        this.activeAxis = 'beta'; // Which axis to use for normalized tilt
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
    setCalibration(minTilt, maxTilt, axis = 'beta') {
        this.minTilt = minTilt;
        this.maxTilt = maxTilt;
        this.activeAxis = axis;
        console.log(`Calibration set: ${axis} [${minTilt.toFixed(1)}, ${maxTilt.toFixed(1)}]`);
    }

    /**
     * Handle orientation event
     */
    _handleOrientation(event) {
        if (!this.isActive) return;

        // beta: front-to-back tilt (-180 to 180)
        // gamma: left-to-right tilt (-90 to 90)
        const beta = event.beta;
        const gamma = event.gamma;

        if (beta === null || gamma === null) return;

        // Store raw values
        this.rawBeta = beta;
        this.rawGamma = gamma;

        // Use the active axis for normalization
        const rawValue = this.activeAxis === 'beta' ? beta : gamma;

        // Map to normalized value between min and max calibration
        if (this.minTilt !== 0 || this.maxTilt !== 0) {
            // Calibrated mode
            const range = this.maxTilt - this.minTilt;
            const normalized = (rawValue - this.minTilt) / range;
            // Allow 30% overflow beyond calibrated range (-0.3 to 1.3)
            this.currentTilt = Math.max(-0.3, Math.min(1.3, normalized));
        } else {
            // Uncalibrated mode - just pass through raw value
            this.currentTilt = rawValue;
        }

        // Call callback if set
        if (this.onTiltChange) {
            this.onTiltChange(this.currentTilt, rawValue);
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
            max: this.maxTilt,
            axis: this.activeAxis
        };
    }

    /**
     * Get raw orientation values
     */
    getRawOrientation() {
        return {
            beta: this.rawBeta,
            gamma: this.rawGamma
        };
    }
}
