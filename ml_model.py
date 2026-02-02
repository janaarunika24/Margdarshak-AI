import numpy as np
import logging

logger = logging.getLogger("marg_ml")
logging.basicConfig(level=logging.INFO)

try:
    import tensorflow as tf
    from tensorflow.keras.models import Sequential
    from tensorflow.keras.layers import LSTM, Dense
    TF = True
    logger.info("TensorFlow ON")
except:
    TF = False
    logger.info("TensorFlow OFF — using fallback")


def build_lstm(input_shape):
    model = Sequential([
        LSTM(64, input_shape=input_shape),
        Dense(16, activation="relu"),
        Dense(1)
    ])
    model.compile(optimizer="adam", loss="mse")
    return model


def train_and_predict(arr, ts=5):
    arr = np.array(arr).astype(float).flatten()
    if len(arr) == 0:
        return 0.0

    if not TF or len(arr) <= ts:
        # fallback predictor
        if len(arr) < 2:
            return float(arr[-1])
        diff = np.mean(np.diff(arr))
        return max(0, float(arr[-1] + diff))

    # LSTM
    X, y = [], []
    #trying my luck
    for i in range(len(arr) - ts):
        X.append(arr[i:i+ts])
        y.append(arr[i+ts])

    X = np.array(X).reshape(-1, ts, 1)
    y = np.array(y)

    model = build_lstm((ts, 1))
    try:
        model.fit(X, y, epochs=6, verbose=0)
        pred = model.predict(arr[-ts:].reshape(1, ts, 1), verbose=0)[0][0]
        return max(0, float(pred))
    except:
        diff = np.mean(np.diff(arr[-(ts+1):]))
        return max(0, float(arr[-1] + diff))
