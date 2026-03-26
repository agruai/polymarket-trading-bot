import { logger } from "./logger";

/**
 * Price prediction result
 */
export interface PricePrediction {
    predictedPrice: number;
    confidence: number; // 0-1, higher = more confident
    direction: "up" | "down"; // No neutral - always up or down
    signal: "BUY_UP" | "BUY_DOWN" | "HOLD";
    features: {
        momentum: number;
        volatility: number;
        trend: number;
    };
    isPoleValue?: boolean; // True if prediction was made at a pole (peak/trough)
}

/**
 * Adaptive Multi-Feature Linear Regression Price Predictor
 * 
 * Uses multiple features (price history, momentum, volatility, spread) to predict next price.
 * Adapts weights in real-time using online gradient descent.
 * 
 * Performance: ~12-15ms per prediction
 */
export class AdaptivePricePredictor {
    // Price history — fixed-size ring buffer (avoids O(n) shift on every tick)
    private readonly maxHistorySize = 10;
    private priceRing: number[] = new Array(10).fill(0);
    private tsRing: number[] = new Array(10).fill(0);
    private ringLen = 0;  // items currently stored (0..maxHistorySize)
    private ringHead = 0; // next write index
    
    // Noise filtering - ignore changes < 0.02 (only filter UNDER 0.02, consider >= 0.02)
    private readonly noiseThreshold = 0.02; // Ignore price changes < 0.02 (must be >= 0.02 to be considered)
    private smoothedPrice: number | null = null; // Current smoothed price
    private lastAddedPrice: number | null = null; // Last price added to history
    private smoothingAlpha = 0.5; // EMA smoothing factor (0.5 = balanced, more responsive to actual price changes)
    
    // Stability detection (for periods of no movement)
    private stablePriceCount = 0; // Count of consecutive stable prices
    private readonly maxStableCount = 5; // After this many stable prices, reduce confidence
    private lastStablePrice: number | null = null;
    
    // Model weights (learned parameters)
    // IMPROVED: Based on log analysis showing stronger trend/momentum and lower volatility correlate with success
    private weights: {
        intercept: number;
        priceLag1: number; // Previous price
        priceLag2: number; // 2 periods ago
        priceLag3: number; // 3 periods ago
        momentum: number;
        volatility: number;
        trend: number;
    } = {
        intercept: 0.5,
        priceLag1: 0.25, // Reduced - recent price less important than trend/momentum
        priceLag2: 0.08,
        priceLag3: 0.04,
        momentum: 0.35, // INCREASED - stronger momentum correlates with success
        volatility: -0.20, // INCREASED penalty - lower volatility strongly correlates with success
        trend: 0.45, // INCREASED - stronger trend signals correlate with success (most reliable)
    };
    
    // Learning parameters
    private readonly learningRate = 0.05; // Increased from 0.01 for faster learning
    private readonly minLearningRate = 0.005; // Increased minimum
    private readonly maxLearningRate = 0.2; // Increased maximum
    
    // Statistics for normalization
    private priceMean = 0.5;
    private priceStd = 0.1;
    private predictionCount = 0;
    private correctPredictions = 0;
    
    // Recent accuracy tracking (sliding window for better adaptation)
    private recentPredictions: Array<{ correct: boolean; confidence: number }> = [];
    private readonly recentWindowSize = 20; // Track last 20 predictions
    // Running counters to avoid filter/reduce on every confidence calc
    private recentCorrectCount = 0;
    private recentHighConfCount = 0;       // confidence >= 0.80
    private recentHighConfCorrectCount = 0;
    
    // EMA for trend - using shorter periods for faster response
    private emaShort = 0.5; // Fast EMA (2 periods) - faster response
    private emaLong = 0.5; // Slow EMA (5 periods) - medium response
    private readonly alphaShort = 2 / (2 + 1); // Faster EMA
    private readonly alphaLong = 2 / (5 + 1); // Medium EMA
    private poleHistory: Array<{ price: number; type: "peak" | "trough"; timestamp: number }> = new Array(10);
    private poleHistoryLen = 0;
    private poleHistoryHead = 0;
    private readonly poleHistoryMax = 10;
    private lastPolePrice: number | null = null;
    private lastPoleType: "peak" | "trough" | null = null;
    private lastPrediction: PricePrediction | null = null; // Store last prediction for pole-based updates
    private lastPoleTimestamp: number | null = null; // Track time since last pole for time-based features
    
    // Price range limits - stop predictions outside this range
    private readonly minPrice = 0.003;
    private readonly maxPrice = 0.97;

    // Pre-allocated scratch buffer for snapshotPrices — avoids GC on hot path
    private snapshotBuf: number[] = new Array(10).fill(0);

    /** Push a value into the ring buffer. O(1). */
    private ringPush(price: number, ts: number): void {
        this.priceRing[this.ringHead] = price;
        this.tsRing[this.ringHead] = ts;
        this.ringHead = (this.ringHead + 1) % this.maxHistorySize;
        if (this.ringLen < this.maxHistorySize) this.ringLen++;
    }

    /** Read the i-th oldest entry (0 = oldest, ringLen-1 = newest). */
    private ringAt(i: number): number {
        const start = this.ringLen < this.maxHistorySize
            ? 0
            : this.ringHead;
        return this.priceRing[(start + i) % this.maxHistorySize];
    }

    /** Fill the reusable snapshot buffer with prices in chronological order. Returns a view of length ringLen. */
    private snapshotPrices(): number[] {
        const start = this.ringLen < this.maxHistorySize ? 0 : this.ringHead;
        for (let i = 0; i < this.ringLen; i++) {
            this.snapshotBuf[i] = this.priceRing[(start + i) % this.maxHistorySize];
        }
        // Return a fixed-length view; callers use the known ringLen
        return this.snapshotBuf;
    }

    /** Push to the fixed-size pole history ring. O(1) — no shift(). */
    private polePush(price: number, type: "peak" | "trough", timestamp: number): void {
        const entry = this.poleHistory[this.poleHistoryHead];
        if (entry) {
            entry.price = price; entry.type = type; entry.timestamp = timestamp;
        } else {
            this.poleHistory[this.poleHistoryHead] = { price, type, timestamp };
        }
        this.poleHistoryHead = (this.poleHistoryHead + 1) % this.poleHistoryMax;
        if (this.poleHistoryLen < this.poleHistoryMax) this.poleHistoryLen++;
    }
    
    /**
     * Update predictor with new price
     * Returns prediction for next price
     */
    public updateAndPredict(price: number, timestamp: number): PricePrediction | null {
        const startTime = Date.now();
        
        // CRITICAL: Stop predictions if price is outside valid range (0.003 to 0.97)
        if (price < this.minPrice || price > this.maxPrice) {
            // Price outside valid range - stop predictions until next market
            // Predictions will resume when reset() is called (new market cycle)
            return null;
        }
        
        if (this.smoothedPrice === null) {
            this.smoothedPrice = price;
            this.lastAddedPrice = price;
            this.ringPush(price, timestamp);
            return null;
        }
        
        // Check ACTUAL price change first (before smoothing) - use raw price for threshold check
        const actualPriceChange = this.lastAddedPrice !== null 
            ? Math.abs(price - this.lastAddedPrice)
            : 0;
        
        // CRITICAL: Filter only changes UNDER 0.02 (strictly < 0.02)
        // Changes >= 0.02 should be considered for prediction
        if (this.lastAddedPrice !== null && actualPriceChange < this.noiseThreshold) {
            // Price change too small (< 0.02) - ignore completely, don't make prediction, don't add to history
            return null;
        }
        
        // Update smoothed price using EMA (only if change is significant)
        this.smoothedPrice = this.smoothingAlpha * price + (1 - this.smoothingAlpha) * (this.smoothedPrice ?? price);
        
        // Also check smoothed price is in valid range
        if (this.smoothedPrice < this.minPrice || this.smoothedPrice > this.maxPrice) {
            return null;
        }
        
        // Use smoothed price change for further processing (but threshold already checked with raw price)
        const smoothedPriceChange = Math.abs(this.smoothedPrice - (this.lastAddedPrice ?? this.smoothedPrice));
        
        // Only process if change is significant (>= 0.02)
        // Detect stability (using smoothed change for stability detection)
        const isStable = smoothedPriceChange < this.noiseThreshold;
        
        if (isStable) {
            this.stablePriceCount++;
            if (this.lastStablePrice !== null && Math.abs(this.smoothedPrice - this.lastStablePrice) < 0.001) {
                // Price is completely stable
            } else {
                this.lastStablePrice = this.smoothedPrice;
            }
        } else {
            this.stablePriceCount = 0;
            this.lastStablePrice = null;
        }
        
        // Add to ring buffer (change is significant >= 0.02)
        this.ringPush(this.smoothedPrice, timestamp);
        this.lastAddedPrice = this.smoothedPrice;
        
        if (this.ringLen < 3) {
            return null;
        }
        
        // Use smoothed price for all calculations
        const currentSmoothedPrice = this.smoothedPrice ?? price;
        
        // Fill reusable snapshot buffer — zero allocation on hot path
        const prices = this.snapshotPrices();
        const n = this.ringLen;

        // CRITICAL: Only make predictions at pole values (peaks and troughs)
        const isPole = this.detectPole(currentSmoothedPrice, timestamp, prices, n);
        
        // If not at a pole, return null - NO PREDICTION
        if (!isPole) {
            return null;
        }
        
        // Update statistics
        this.updateStatistics(prices, n);
        
        // Calculate features
        const features = this.calculateFeatures(prices, n);
        
        // Make prediction
        const predictedPrice = this.predictPrice(features);
        
        // Update EMA with smoothed price
        this.updateEMA(currentSmoothedPrice);
        
        if (this.ringLen >= 4) {
            this.learnFromPreviousPrediction(prices, n);
        }
        
        // Calculate confidence (use smoothed price)
        const confidence = this.calculateConfidence(features, predictedPrice, currentSmoothedPrice);
        
        // Determine direction (compare predicted vs smoothed price) - no neutral, always up or down
        const direction = this.getDirection(predictedPrice, currentSmoothedPrice, features);
        
        // Generate signal
        const signal = this.generateSignal(direction, confidence, features);
        
        const elapsed = Date.now() - startTime;
        if (elapsed > 20) {
            logger.error(`Price prediction took ${elapsed}ms (exceeds 20ms limit)`);
        }
        
        const prediction: PricePrediction = {
            predictedPrice,
            confidence,
            direction,
            signal,
            isPoleValue: isPole,
            features: {
                momentum: features.momentum,
                volatility: features.volatility,
                trend: features.trend,
            },
        };
        
        // Store prediction for reuse when not at pole
        this.lastPrediction = prediction;
        
        return prediction;
    }
    
    /**
     * Detect pole values (local peaks and troughs)
     * Returns true if current price is at a pole (peak or trough)
     */
    private detectPole(currentPrice: number, timestamp: number, prices: number[], n: number): boolean {
        if (n < 3) return false;
        
        const centerIdx = n - 1;
        const centerPrice = prices[centerIdx];
        
        if (centerIdx < 2) return false;
        
        let isPeak = true;
        let isTrough = true;
        
        const lookback = Math.min(3, centerIdx);
        for (let i = centerIdx - lookback; i < centerIdx; i++) {
            const p = prices[i];
            if (p >= centerPrice) isPeak = false;
            if (p <= centerPrice) isTrough = false;
        }
        
        if (!isPeak && !isTrough) return false;
        
        if (this.lastPolePrice === null) {
            this.lastPolePrice = centerPrice;
            this.lastPoleType = isPeak ? "peak" : "trough";
            this.lastPoleTimestamp = timestamp;
            this.polePush(centerPrice, this.lastPoleType, timestamp);
            return true;
        }
        
        const changeFromLastPole = Math.abs(centerPrice - this.lastPolePrice);
        const isDifferentPoleType = (isPeak && this.lastPoleType === "trough") || 
                                    (isTrough && this.lastPoleType === "peak");
        
        if (changeFromLastPole >= this.noiseThreshold || isDifferentPoleType) {
            this.lastPolePrice = centerPrice;
            this.lastPoleType = isPeak ? "peak" : "trough";
            this.lastPoleTimestamp = timestamp;
            this.polePush(centerPrice, this.lastPoleType, timestamp);
            return true;
        }
        return false;
    }
    
    /**
     * Calculate features from price history
     */
    private calculateFeatures(prices: number[], n: number): {
        priceLag1: number;
        priceLag2: number;
        priceLag3: number;
        momentum: number;
        volatility: number;
        trend: number;
    } {
        const currentPrice = prices[n - 1];
        const priceLag1 = n >= 2 ? prices[n - 2] : currentPrice;
        const priceLag2 = n >= 3 ? prices[n - 3] : priceLag1;
        const priceLag3 = n >= 4 ? prices[n - 4] : priceLag2;
        
        const priceChange = currentPrice - priceLag1;
        let effectiveMomentum = priceLag1 > 0 ? priceChange / priceLag1 : 0;
        
        if (n >= 4) {
            const longerTermChange = currentPrice - priceLag2;
            if ((priceChange > 0 && longerTermChange > 0) || (priceChange < 0 && longerTermChange < 0)) {
                effectiveMomentum = (effectiveMomentum + (longerTermChange / (priceLag2 + 0.0001))) * 0.5;
            }
        }
        
        const emaTrend = this.emaShort - this.emaLong;
        const momentumTrend = effectiveMomentum * 0.5;
        const priceChangeTrend = n >= 3 ? (currentPrice - priceLag2) / (priceLag2 + 0.0001) * 0.3 : 0;
        const combinedTrend = emaTrend * 0.4 + momentumTrend * 0.4 + priceChangeTrend * 0.2;
        
        return {
            priceLag1: this.normalizePrice(priceLag1),
            priceLag2: this.normalizePrice(priceLag2),
            priceLag3: this.normalizePrice(priceLag3),
            momentum: this.normalizeMomentum(effectiveMomentum),
            volatility: this.normalizeVolatility(this.calculateVolatility(prices, n)),
            trend: this.normalizeTrend(combinedTrend),
        };
    }
    
    /**
     * Calculate features at an arbitrary index `k` within the prices array (length >= k).
     * Mirrors calculateFeatures exactly so learning trains the same feature space.
     */
    private calculateFeaturesAt(prices: number[], k: number): {
        priceLag1: number;
        priceLag2: number;
        priceLag3: number;
        momentum: number;
        volatility: number;
        trend: number;
    } {
        const currentPrice = prices[k - 1];
        const priceLag1 = k >= 2 ? prices[k - 2] : currentPrice;
        const priceLag2 = k >= 3 ? prices[k - 3] : priceLag1;
        const priceLag3 = k >= 4 ? prices[k - 4] : priceLag2;

        const priceChange = currentPrice - priceLag1;
        let effectiveMomentum = priceLag1 > 0 ? priceChange / priceLag1 : 0;

        if (k >= 4) {
            const longerTermChange = currentPrice - priceLag2;
            if ((priceChange > 0 && longerTermChange > 0) || (priceChange < 0 && longerTermChange < 0)) {
                effectiveMomentum = (effectiveMomentum + (longerTermChange / (priceLag2 + 0.0001))) * 0.5;
            }
        }

        const emaTrend = this.emaShort - this.emaLong;
        const momentumTrend = effectiveMomentum * 0.5;
        const priceChangeTrend = k >= 3 ? (currentPrice - priceLag2) / (priceLag2 + 0.0001) * 0.3 : 0;
        const combinedTrend = emaTrend * 0.4 + momentumTrend * 0.4 + priceChangeTrend * 0.2;

        return {
            priceLag1: this.normalizePrice(priceLag1),
            priceLag2: this.normalizePrice(priceLag2),
            priceLag3: this.normalizePrice(priceLag3),
            momentum: this.normalizeMomentum(effectiveMomentum),
            volatility: this.normalizeVolatility(this.calculateVolatility(prices, k)),
            trend: this.normalizeTrend(combinedTrend),
        };
    }

    /** Single-pass mean + variance over the last 5 entries — no slice, no reduce. */
    private calculateVolatility(prices: number[], n: number): number {
        if (n < 3) return 0;
        const start = n > 5 ? n - 5 : 0;
        const count = n - start;
        let sum = 0;
        for (let i = start; i < n; i++) sum += prices[i];
        const mean = sum / count;
        let variance = 0;
        for (let i = start; i < n; i++) { const d = prices[i] - mean; variance += d * d; }
        return Math.sqrt(variance / count);
    }
    
    /**
     * Predict price using linear regression
     */
    private predictPrice(features: ReturnType<typeof this.calculateFeatures>): number {
        const prediction = 
            this.weights.intercept +
            this.weights.priceLag1 * features.priceLag1 +
            this.weights.priceLag2 * features.priceLag2 +
            this.weights.priceLag3 * features.priceLag3 +
            this.weights.momentum * features.momentum +
            this.weights.volatility * features.volatility +
            this.weights.trend * features.trend;
        
        // Denormalize
        return this.denormalizePrice(prediction);
    }
    
    /**
     * Learn from previous prediction using online gradient descent.
     * Reconstructs the feature vector that *would* have been calculated at time n-1,
     * so that weight updates correlate to the same features used during prediction.
     */
    private learnFromPreviousPrediction(prices: number[], n: number): void {
        if (n < 4) return;
        const actualPrice = prices[n - 1];
        const previousPrice = prices[n - 2];

        // Reconstruct features as calculateFeatures would have seen them at index n-1
        const prevFeatures = this.calculateFeaturesAt(prices, n - 1);
        
        const predictedPrice = this.predictPrice(prevFeatures);
        const error = actualPrice - predictedPrice;
        
        // IMPROVED: More aggressive learning from mistakes
        const errorMagnitude = Math.abs(error);
        const normalizedError = Math.min(1, errorMagnitude * 10); // Normalize error to [0, 1]
        
        // Check if prediction was wrong (direction-wise) - calculate once
        const predictedDirection = predictedPrice > previousPrice ? 1 : (predictedPrice < previousPrice ? -1 : 0);
        const actualDirection = actualPrice > previousPrice ? 1 : (actualPrice < previousPrice ? -1 : 0);
        const wasWrong = predictedDirection !== actualDirection && predictedDirection !== 0 && actualDirection !== 0;
        const directionCorrect = predictedDirection === actualDirection && predictedDirection !== 0;
        
        // Higher learning rate for wrong predictions and larger errors
        // Much more aggressive learning from mistakes - improved based on log analysis
        const errorMultiplier = wasWrong ? 8.0 : 2.5; // Increased from 7.0 to 8.0 for wrong predictions
        const adaptiveLR = Math.max(
            this.minLearningRate,
            Math.min(this.maxLearningRate, this.learningRate * (1 + normalizedError * errorMultiplier))
        );
        
        // Update weights using gradient descent - faster learning from mistakes
        // More aggressive decay reduction for wrong predictions to learn faster
        const decay = wasWrong ? 0.85 : 0.97; // Less decay (faster learning) when wrong - even more aggressive (0.88 → 0.85)
        this.weights.intercept = this.weights.intercept * decay + adaptiveLR * error;
        this.weights.priceLag1 = this.weights.priceLag1 * decay + adaptiveLR * error * prevFeatures.priceLag1;
        this.weights.priceLag2 = this.weights.priceLag2 * decay + adaptiveLR * error * prevFeatures.priceLag2;
        this.weights.priceLag3 = this.weights.priceLag3 * decay + adaptiveLR * error * prevFeatures.priceLag3;
        this.weights.momentum = this.weights.momentum * decay + adaptiveLR * error * prevFeatures.momentum;
        this.weights.volatility = this.weights.volatility * decay + adaptiveLR * error * (prevFeatures.volatility || 0.1);
        this.weights.trend = this.weights.trend * decay + adaptiveLR * error * (prevFeatures.trend || 0);
        
        // Track prediction accuracy (improved logic)
        this.predictionCount++;
        if (directionCorrect) {
            this.correctPredictions++;
        }
        
        // Track recent predictions with running counters (avoid filter/reduce per call)
        const lastConfidence = this.lastPrediction?.confidence || 0.5;
        const entry = { correct: directionCorrect, confidence: lastConfidence };
        if (this.recentPredictions.length >= this.recentWindowSize) {
            const evicted = this.recentPredictions.shift()!;
            if (evicted.correct) this.recentCorrectCount--;
            if (evicted.confidence >= 0.80) {
                this.recentHighConfCount--;
                if (evicted.correct) this.recentHighConfCorrectCount--;
            }
        }
        this.recentPredictions.push(entry);
        if (directionCorrect) this.recentCorrectCount++;
        if (lastConfidence >= 0.80) {
            this.recentHighConfCount++;
            if (directionCorrect) this.recentHighConfCorrectCount++;
        }
    }
    
    /**
     * Calculate prediction confidence
     */
    private calculateConfidence(
        features: ReturnType<typeof this.calculateFeatures>,
        predictedPrice: number,
        currentPrice: number
    ): number {
        // Base confidence on:
        // 1. Volatility (lower volatility = higher confidence)
        // 2. Trend strength (stronger trend = higher confidence)
        // 3. Momentum consistency
        // 4. Prediction magnitude (larger predicted change = higher confidence if trend aligns)
        
        // IMPROVED: Based on analysis - lower volatility (0.086) vs wrong (0.093) correlates with success
        // Apply MUCH stronger penalty for high volatility (> 0.08)
        const volatilityPenalty = features.volatility > 0.08 ? 0.25 : (features.volatility > 0.06 ? 0.10 : 0); // Extra penalty for high volatility
        const volatilityFactor = Math.max(0.20, 1 - features.volatility * 12 - volatilityPenalty); // Increased multiplier from 10 to 12
        
        // IMPROVED: Based on analysis - stronger trend (0.018) vs wrong (-0.009) correlates with success
        const trendFactor = Math.min(1, Math.abs(features.trend) * 10); // INCREASED multiplier from 8 to 10
        
        // IMPROVED: Based on analysis - stronger momentum (0.006) vs wrong (-0.004) correlates with success
        const momentumFactor = Math.min(1, Math.abs(features.momentum) * 4); // INCREASED multiplier from 3 to 4
        
        // Prediction magnitude factor - if prediction is significant and aligns with trend
        // Only consider changes >= 0.02, ignore < 0.02
        const predDiff = Math.abs(predictedPrice - currentPrice);
        const predMagnitudeFactor = predDiff >= this.noiseThreshold 
            ? Math.min(1, predDiff * 20) // Larger predicted change = higher confidence (only if >= 0.02)
            : 0; // Ignore predictions with changes < 0.02
        
        // Momentum-direction alignment
        const momentumAlignment = (features.momentum > 0 && predictedPrice > currentPrice) || 
                                  (features.momentum < 0 && predictedPrice < currentPrice) ? 1.0 : 0.7;
        
        // Historical accuracy (weighted more heavily if we have enough data)
        const overallAccuracy = this.predictionCount > 10 
            ? this.correctPredictions / this.predictionCount 
            : 0.6; // Default to 60% if not enough data
        
        const recentLen = this.recentPredictions.length;
        const recentAccuracy = recentLen > 0
            ? this.recentCorrectCount / recentLen
            : 0.6;
        
        const accuracyRate = recentAccuracy * 0.6 + overallAccuracy * 0.4;
        
        // Stability penalty: reduce confidence if price has been stable for too long
        let stabilityFactor = 1.0;
        if (this.stablePriceCount > this.maxStableCount) {
            // Price is very stable - reduce confidence significantly
            stabilityFactor = Math.max(0.5, 1.0 - (this.stablePriceCount - this.maxStableCount) * 0.1);
        } else if (this.stablePriceCount > 0) {
            // Slightly reduce confidence for stable prices
            stabilityFactor = 0.9;
        }
        
        // Weights normalised to sum = 1.0 so raw confidence is well-calibrated [0,1].
        // Relative importance preserved: trend > momentum > accuracy > volatility > magnitude > alignment.
        let confidence = (
            volatilityFactor * 0.12 +
            trendFactor * 0.31 +
            momentumFactor * 0.19 +
            predMagnitudeFactor * 0.08 +
            accuracyRate * 0.21 +
            momentumAlignment * 0.09
        );
        
        // Apply overconfidence penalty if recent high-confidence predictions were wrong
        if (recentLen >= 10 && this.recentHighConfCount >= 5) {
            const highConfAccuracy = this.recentHighConfCorrectCount / this.recentHighConfCount;
            if (highConfAccuracy < 0.65) {
                const overconfidencePenalty = 0.85 - (0.65 - highConfAccuracy) * 0.5;
                confidence *= Math.max(0.70, overconfidencePenalty);
            }
        }
        
        // Apply stability factor - more penalty for unstable prices
        confidence *= Math.max(0.85, stabilityFactor); // More penalty for stability issues
        
        // IMPROVED: Based on analysis - require stronger trend/momentum signals for confidence boost
        // Analysis shows successful predictions have avg trend 0.018 vs wrong -0.009
        // Analysis shows successful predictions have avg momentum 0.006 vs wrong -0.004
        const strongTrend = Math.abs(features.trend) > 0.015; // LOWERED threshold from 0.05 - analysis shows even small positive trends matter
        const strongMomentum = Math.abs(features.momentum) > 0.005; // LOWERED threshold from 0.03 - analysis shows even small positive momentum matters
        const aligned = (features.trend > 0 && features.momentum > 0) || (features.trend < 0 && features.momentum < 0);
        
        // IMPROVED: More aggressive boost for aligned strong signals (analysis shows this correlates with success)
        if (strongTrend && strongMomentum && aligned && accuracyRate >= 0.55) {
            // Strong aligned signals - increased boost based on analysis
            const alignmentStrength = Math.min(1, (Math.abs(features.trend) + Math.abs(features.momentum)) * 6.0); // Increased from 5.0
            confidence = Math.min(0.95, confidence * (1 + alignmentStrength * 0.40)); // INCREASED from 0.35 to 0.40
        } else if ((strongTrend || strongMomentum) && accuracyRate >= 0.55) {
            // Only one strong signal - moderate boost
            confidence = Math.min(0.90, confidence * 1.15); // INCREASED from 1.10 to 1.15
        }
        
        // ADDITIONAL: Penalize high volatility more aggressively (analysis shows lower vol = success)
        if (features.volatility > 0.09) {
            // Very high volatility reduces confidence significantly
            confidence *= 0.80; // 20% penalty for very high volatility
        } else if (features.volatility > 0.08) {
            // High volatility reduces confidence
            confidence *= 0.88; // 12% penalty for high volatility
        } else if (features.volatility > 0.06) {
            // Moderate volatility - slight penalty
            confidence *= 0.95; // 5% penalty for moderate volatility
        }
        
        // Boost confidence if prediction magnitude is large AND aligns with trend AND accuracy is good
        if (predDiff >= 0.02 && aligned && accuracyRate >= 0.55) {
            confidence = Math.min(0.95, confidence * 1.20); // Reduced boost, cap at 95%
        }
        
        // Additional boost for very large predictions (>= 0.10) with alignment
        if (predDiff >= 0.10 && aligned && accuracyRate >= 0.60) {
            confidence = Math.min(0.95, confidence * 1.10); // Reduced boost, cap at 95%
        }
        
        // CRITICAL: Prevent overconfidence (confidence = 1.00 is often wrong)
        // Cap maximum confidence based on recent accuracy - MUCH more conservative
        if (recentLen >= 10) {
            const recentAccuracy = this.recentCorrectCount / recentLen;
            // Very conservative cap: max confidence = 0.60 + (recentAccuracy * 0.30)
            // This ensures confidence never exceeds what recent performance justifies
            const maxConfidence = Math.min(0.92, 0.60 + recentAccuracy * 0.32); // More conservative cap
            confidence = Math.min(maxConfidence, confidence);
            
            // Additional penalty: if recent accuracy is below 60%, cap confidence even lower
            if (recentAccuracy < 0.55) {
                confidence = Math.min(0.75, confidence); // Hard cap at 75% if accuracy is very low
            } else if (recentAccuracy < 0.60) {
                confidence = Math.min(0.80, confidence); // Hard cap at 80% if accuracy is low
            } else if (recentAccuracy < 0.65) {
                confidence = Math.min(0.85, confidence); // Hard cap at 85% if accuracy is moderate
            }
        } else {
            // Default cap if not enough data - be very conservative early
            confidence = Math.min(0.85, confidence); // Reduced from 0.90 to 0.85
        }
        
        // ABSOLUTE HARD CAP: Never allow confidence above 92% (100% confidence is often wrong)
        confidence = Math.min(0.92, confidence);
        
        // STRICT PENALTY: If trend and momentum don't align, significantly reduce confidence
        if ((features.trend > 0 && features.momentum < -0.03) || (features.trend < 0 && features.momentum > 0.03)) {
            confidence = Math.max(0.35, confidence * 0.70); // Strong penalty for misalignment
        }
        
        // Special case: if price is very stable, lower confidence significantly
        if (this.stablePriceCount > this.maxStableCount * 2) {
            confidence = Math.max(0.35, confidence * 0.65); // Strong penalty for very stable prices
        }
        
        // CRITICAL: Don't allow minimum confidence to be too high - let weak signals be filtered out
        // If confidence is below 55%, it's likely a weak signal - don't force it to 50%
        return Math.max(0.40, Math.min(1, confidence)); // Lower minimum to allow filtering of weak signals
    }
    
    /**
     * Determine price direction - always returns "up" or "down", never "neutral"
     * Accepts pre-computed features to avoid redundant calculation.
     */
    private getDirection(
        predictedPrice: number,
        currentPrice: number,
        features: ReturnType<typeof this.calculateFeatures>
    ): "up" | "down" {
        const diff = predictedPrice - currentPrice;
        const minChangeThreshold = this.noiseThreshold;
        
        const effectiveThreshold = this.stablePriceCount > this.maxStableCount 
            ? minChangeThreshold * 2
            : minChangeThreshold;
        
        // Always return up or down based on prediction and trend/momentum, never neutral
        // If change is significant (>= 0.02), use prediction; otherwise use trend/momentum
        if (Math.abs(diff) >= effectiveThreshold) {
            // Significant change - use prediction, but verify with momentum/trend
            const predictionDirection = diff > 0 ? "up" : "down";
            
            // If momentum aligns with prediction, trust prediction
            const momentumAligned = (predictionDirection === "up" && features.momentum > -0.01) || 
                                    (predictionDirection === "down" && features.momentum < 0.01);
            
            // If trend aligns with prediction, trust prediction
            const trendAligned = (predictionDirection === "up" && features.trend > -0.01) || 
                                (predictionDirection === "down" && features.trend < 0.01);
            
            // If both align, use prediction; otherwise, use trend/momentum
            if (momentumAligned || trendAligned) {
                return predictionDirection;
            } else {
                // Prediction doesn't align with momentum/trend - use trend/momentum instead
                if (features.trend > 0.001 || features.momentum > 0.001) {
                    return "up";
                } else if (features.trend < -0.001 || features.momentum < -0.001) {
                    return "down";
                } else {
                    // Fallback to prediction direction
                    return predictionDirection;
                }
            }
        } else {
            // Change too small - use trend/momentum to determine direction
            // Use trend to determine direction (neutral+up → up, neutral+down → down)
            if (features.trend > 0.001) {
                return "up"; // Upward trend
            } else if (features.trend < -0.001) {
                return "down"; // Downward trend
            } else {
                // No clear trend, use momentum
                if (features.momentum > 0.001) {
                    return "up"; // Positive momentum → up
                } else if (features.momentum < -0.001) {
                    return "down"; // Negative momentum → down
                } else {
                    // No clear signal - use last pole type or default
                    if (this.lastPoleType === "peak") return "down"; // After peak, expect down
                    if (this.lastPoleType === "trough") return "up"; // After trough, expect up
                    return "up"; // Default to up
                }
            }
        }
    }
    
    /**
     * Generate trading signal
     * Only generates signals for changes >= 0.02, ignores changes < 0.02
     * Direction is always "up" or "down" (no neutral)
     */
    private generateSignal(
        direction: "up" | "down",
        confidence: number,
        features: ReturnType<typeof this.calculateFeatures>
    ): "BUY_UP" | "BUY_DOWN" | "HOLD" {
        
        // IMPROVED: More conservative signal generation to reduce false positives
        // Require higher confidence and stronger alignment
        
        // Running counter instead of filter on every signal
        let recentAccuracy = 0.6;
        if (this.recentPredictions.length >= 10) {
            recentAccuracy = this.recentCorrectCount / this.recentPredictions.length;
        }
        
        // Adaptive thresholds: be more selective when accuracy is low, but allow trades at reasonable confidence
        // Balanced approach - not too conservative, but still quality-focused
        const minConfidenceForTrade = recentAccuracy < 0.50 ? 0.65 : (recentAccuracy < 0.55 ? 0.60 : 0.55); // Lower thresholds
        
        // Very high confidence: trade if confidence >= 75% AND trend/momentum align
        if (confidence >= 0.75) {
            const strongTrend = Math.abs(features.trend) > 0.012;
            const aligned = (direction === "up" && features.trend > 0.012 && features.momentum > -0.03) ||
                           (direction === "down" && features.trend < -0.012 && features.momentum < 0.03);
            const lowVolatility = features.volatility < 0.10; // More lenient volatility requirement
            
            if (strongTrend && aligned && lowVolatility) {
                if (direction === "up") return "BUY_UP";
                if (direction === "down") return "BUY_DOWN";
            }
        }
        
        // High confidence: require strong alignment (68-75%)
        if (confidence >= 0.68) {
            const strongTrend = Math.abs(features.trend) > 0.015;
            const trendAligned = (direction === "up" && features.trend > 0.015) || 
                                (direction === "down" && features.trend < -0.015);
            const momentumAligned = (direction === "up" && features.momentum > -0.04) || 
                                   (direction === "down" && features.momentum < 0.04);
            const lowVolatility = features.volatility < 0.10;
            
            if (strongTrend && trendAligned && momentumAligned && lowVolatility) {
                if (direction === "up") return "BUY_UP";
                if (direction === "down") return "BUY_DOWN";
            }
        }
        
        // Medium-high confidence: require strong alignment (62-68%)
        if (confidence >= 0.62) {
            const strongTrend = Math.abs(features.trend) > 0.018;
            const aligned = (direction === "up" && features.trend > 0.018 && features.momentum > -0.04) ||
                           (direction === "down" && features.trend < -0.018 && features.momentum < 0.04);
            const lowVolatility = features.volatility < 0.11;
            
            if (strongTrend && aligned && lowVolatility) {
                if (direction === "up") return "BUY_UP";
                if (direction === "down") return "BUY_DOWN";
            }
        }
        
        // Medium confidence: require good alignment (55-62%) - this is where most trades should happen
        if (confidence >= minConfidenceForTrade) {
            // For medium confidence, require strong trend OR strong momentum with alignment
            // Trend is normalized to [-1, 1], so 0.15 = 15% of max range
            const strongTrend = Math.abs(features.trend) > 0.12; // Strong trend threshold (12% normalized = 0.012 raw)
            const goodMomentum = Math.abs(features.momentum) > 0.02; // Good momentum
            const aligned = (direction === "up" && features.trend > 0.08 && features.momentum > -0.05) ||
                           (direction === "down" && features.trend < -0.08 && features.momentum < 0.05);
            const acceptableVolatility = features.volatility < 0.12;
            
            // Trade if: (strong trend AND aligned) OR (good momentum AND aligned AND acceptable volatility)
            if ((strongTrend && aligned && acceptableVolatility) || 
                (goodMomentum && aligned && acceptableVolatility && confidence >= 0.55)) {
                if (direction === "up") return "BUY_UP";
                if (direction === "down") return "BUY_DOWN";
            }
        }
        
        // Lower confidence (50-55%): Only trade if trend is VERY strong
        if (confidence >= 0.50 && recentAccuracy >= 0.50) {
            const veryStrongTrend = Math.abs(features.trend) > 0.15; // Very strong trend (15%+ normalized)
            const aligned = (direction === "up" && features.trend > 0.12 && features.momentum > -0.05) ||
                           (direction === "down" && features.trend < -0.12 && features.momentum < 0.05);
            const acceptableVolatility = features.volatility < 0.11;
            
            if (veryStrongTrend && aligned && acceptableVolatility) {
                if (direction === "up") return "BUY_UP";
                if (direction === "down") return "BUY_DOWN";
            }
        }
        
        // Default: HOLD - don't trade on weak signals
        return "HOLD";
    }
    
    /**
     * Update EMA
     */
    private updateEMA(price: number): void {
        if (this.emaShort === 0.5 && this.emaLong === 0.5) {
            // Initialize
            this.emaShort = price;
            this.emaLong = price;
        } else {
            this.emaShort = this.alphaShort * price + (1 - this.alphaShort) * this.emaShort;
            this.emaLong = this.alphaLong * price + (1 - this.alphaLong) * this.emaLong;
        }
    }
    
    /**
     * Update price statistics
     */
    /** Single-pass Welford mean + variance — no reduce, no temporary arrays. */
    private updateStatistics(prices: number[], n: number): void {
        if (n === 0) return;
        let sum = 0;
        for (let i = 0; i < n; i++) sum += prices[i];
        const mean = sum / n;
        this.priceMean = mean;
        let v = 0;
        for (let i = 0; i < n; i++) { const d = prices[i] - mean; v += d * d; }
        this.priceStd = Math.sqrt(v / n);
        if (this.priceStd < 0.001) this.priceStd = 0.1;
    }
    
    /**
     * Normalize price to [0, 1] range
     */
    private normalizePrice(price: number): number {
        // Use z-score normalization with clipping
        const normalized = (price - this.priceMean) / this.priceStd;
        // Clip to reasonable range and scale to [0, 1]
        return Math.max(0, Math.min(1, (normalized + 3) / 6));
    }
    
    /**
     * Denormalize price from [0, 1] range
     */
    private denormalizePrice(normalized: number): number {
        // Reverse z-score normalization
        const zScore = (normalized * 6) - 3;
        return zScore * this.priceStd + this.priceMean;
    }
    
    /**
     * Normalize momentum
     */
    private normalizeMomentum(momentum: number): number {
        // Clip momentum to reasonable range [-1, 1]
        return Math.max(-1, Math.min(1, momentum));
    }
    
    /**
     * Normalize volatility
     */
    private normalizeVolatility(volatility: number): number {
        // Normalize volatility to [0, 1] range
        // Typical volatility for prediction markets is 0-0.2
        return Math.min(1, volatility * 5);
    }
    
    /**
     * Normalize trend
     */
    private normalizeTrend(trend: number): number {
        // Normalize trend to [-1, 1] range
        return Math.max(-1, Math.min(1, trend * 10));
    }
    
    /**
     * Get prediction accuracy statistics
     */
    public getAccuracyStats(): { accuracy: number; totalPredictions: number; correctPredictions: number } {
        return {
            accuracy: this.predictionCount > 0 ? this.correctPredictions / this.predictionCount : 0,
            totalPredictions: this.predictionCount,
            correctPredictions: this.correctPredictions,
        };
    }
    
    /**
     * Reset predictor (for new market cycle)
     */
    public reset(): void {
        this.priceRing.fill(0);
        this.tsRing.fill(0);
        this.ringLen = 0;
        this.ringHead = 0;
        this.snapshotBuf.fill(0);
        this.emaShort = 0.5;
        this.emaLong = 0.5;
        this.smoothedPrice = null;
        this.lastAddedPrice = null;
        this.stablePriceCount = 0;
        this.lastStablePrice = null;
        this.poleHistoryLen = 0;
        this.poleHistoryHead = 0;
        this.lastPolePrice = null;
        this.lastPoleType = null;
        this.lastPoleTimestamp = null;
        this.lastPrediction = null;
    }
}

